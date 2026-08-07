/**
 * Shopify `orders/create` webhook → ScheduledCall.
 *
 *   POST /webhook/shopify/orders-create
 *
 * Pipeline:
 *   1. HMAC verify (per-shop secret; each store has its own Custom App)
 *   2. Shop allowlist check (returns 200 on block to avoid leaking shop existence)
 *   3. COD detection (handles "cod", "Cash on Delivery", "cash-on-delivery", ...)
 *   4. Freshness check (skip Shopify-retry-backlog + accidental replays)
 *   5. Phone normalization (E.164)
 *   6. Idempotent upsert into ScheduledCall queue (keyed on shop + orderId)
 *
 * COD-confirm-specific because: the trigger source (Shopify), the gating
 * (payment method = COD), and the payload shape (customer + product + amount
 * + delivery address) are all COD-confirm concerns. Other profiles trigger
 * from different sources — generic POST /calls/dispatch, calendar webhooks,
 * CSV upload, inbound SIP.
 *
 * Factory: createShopifyWebhookRouter({ prisma, computeScheduledAt, isDnd,
 *   isShopAllowed, normalizePhone, env, rejectCount, CALL_DELAY_MS }).
 *
 * NOTE: The caller MUST mount this with `express.raw({ type: 'application/json' })`
 * because HMAC verification reads `req.body` as a Buffer. The recommended
 * mount in server.js is:
 *
 *   import express from 'express';
 *   import { createShopifyWebhookRouter } from '.../triggers/shopify-webhook.js';
 *   app.use(
 *     '/webhook/shopify',
 *     express.raw({ type: 'application/json' }),
 *     createShopifyWebhookRouter(deps),
 *   );
 */
import express from 'express';
import { enqueueHubVoiceCall } from '../../../src/lib/hub-voice-queue.js';
import { appSlugForShop } from '../../../src/lib/shops.js';
import crypto from 'node:crypto';

// Build a spoken-friendly product description from ALL line items, not just
// the first — a multi-item COD order should have every product confirmed.
// 1 item → its title; 2-3 → comma list; >3 → first 3 + "and N more". Quantity
// >1 is annotated so the agent can read it back. Falls back to "your order".
function describeOrderProducts(lineItems) {
  const items = Array.isArray(lineItems) ? lineItems.filter(li => li && li.title) : [];
  if (!items.length) return 'your order';
  const fmt = (li) => {
    const qty = Number(li.quantity) || 1;
    return qty > 1 ? `${li.title} (x${qty})` : li.title;
  };
  if (items.length <= 3) return items.map(fmt).join(', ');
  return `${items.slice(0, 3).map(fmt).join(', ')} and ${items.length - 3} more`;
}

export function createShopifyWebhookRouter({
  prisma,
  computeScheduledAt,
  isDnd,
  isShopAllowed,
  normalizePhone,
  env,
  rejectCount,
  CALL_DELAY_MS,
}) {
  const router = express.Router();

  const SHOPIFY_WEBHOOK_SECRETS = (() => {
    try {
      return JSON.parse(env.SHOPIFY_WEBHOOK_SECRETS || '{}');
    } catch (err) {
      console.error('[config] SHOPIFY_WEBHOOK_SECRETS is not valid JSON — ignoring', err.message);
      return {};
    }
  })();
  const SHOPIFY_WEBHOOK_SECRET = env.SHOPIFY_WEBHOOK_SECRET || '';

  // HMAC enforcement mode:
  //   'enforce' — reject (401) on missing/mismatched HMAC (production target)
  //   'observe' — verify and LOG match/mismatch but still accept (safe rollout:
  //               proves the per-store secret is correct against live webhooks
  //               before we start rejecting). Default 'observe' so turning on
  //               per-store resolution can't suddenly drop the one live store.
  const HMAC_MODE = (env.SHOPIFY_HMAC_ENFORCE || 'observe').toLowerCase() === 'true'
    ? 'enforce'
    : ((env.SHOPIFY_HMAC_ENFORCE || 'observe').toLowerCase());
  const ENFORCE = HMAC_MODE === 'enforce';

  // The secrets map is keyed by Custom App slug (urban, storico, …) but Shopify
  // sends the myshopify domain. Resolve domain → app slug → secret; also try the
  // raw domain (future domain-keyed maps) before the global fallback.
  function resolveShopifySecret(shop) {
    if (shop && SHOPIFY_WEBHOOK_SECRETS[shop]) return SHOPIFY_WEBHOOK_SECRETS[shop];
    const slug = appSlugForShop(shop);
    if (slug && SHOPIFY_WEBHOOK_SECRETS[slug]) return SHOPIFY_WEBHOOK_SECRETS[slug];
    return SHOPIFY_WEBHOOK_SECRET;
  }

  // Staleness filters — prevent calling customers about already-delivered,
  // forgotten, or Shopify-retry-backlog orders.
  //
  // QUEUE_ONLY_AFTER: ISO-8601 timestamp. Orders created on/before this moment
  //   are silently ack'd but NOT queued. Useful for "go-live" events where a
  //   backlog of retries would otherwise flood the queue.
  // MAX_ORDER_AGE_HOURS: rolling freshness check. Default 6 hours.
  const QUEUE_ONLY_AFTER   = env.QUEUE_ONLY_AFTER ? Date.parse(env.QUEUE_ONLY_AFTER) || null : null;
  const MAX_ORDER_AGE_HOURS = Number(env.MAX_ORDER_AGE_HOURS ?? 6);
  function isOrderFresh(order) {
    const created = Date.parse(order.created_at || order.processed_at || '');
    if (!created) return { fresh: true, reason: 'no_created_at' }; // fail-open if Shopify omits
    const now = Date.now();
    if (QUEUE_ONLY_AFTER && created <= QUEUE_ONLY_AFTER) {
      return { fresh: false, reason: `before_go_live_cutoff (created=${new Date(created).toISOString()})` };
    }
    if (MAX_ORDER_AGE_HOURS > 0 && (now - created) > MAX_ORDER_AGE_HOURS * 3600_000) {
      const ageH = ((now - created) / 3600_000).toFixed(1);
      return { fresh: false, reason: `too_old (${ageH}h, limit=${MAX_ORDER_AGE_HOURS}h)` };
    }
    return { fresh: true };
  }

  router.post('/orders-create', async (req, res) => {
    try {
      const hmac = req.get('X-Shopify-Hmac-Sha256');
      const shop = req.get('X-Shopify-Shop-Domain');
      const slug = appSlugForShop(shop);
      const secret = resolveShopifySecret(shop);
      if (secret) {
        if (!hmac) {
          if (rejectCount) rejectCount.hmac_missing++;
          console.warn(`[shopify-hmac] header missing shop=${shop} mode=${HMAC_MODE}`);
          if (ENFORCE) return res.status(401).send('HMAC required');
        } else {
          const expected = crypto.createHmac('sha256', secret).update(req.body).digest('base64');
          const ok = expected.length === hmac.length &&
                     crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(hmac));
          if (ok) {
            console.log(`[shopify-hmac] verified shop=${shop} slug=${slug}`);
          } else {
            if (rejectCount) rejectCount.hmac_mismatch++;
            console.warn(`[shopify-hmac] MISMATCH shop=${shop} slug=${slug} mode=${HMAC_MODE} (secret on file is wrong/stale for this store)`);
            if (ENFORCE) return res.status(401).send('HMAC mismatch');
          }
        }
      } else {
        console.warn(`[shopify-hmac] no secret resolved for shop=${shop} slug=${slug} — accepting UNVERIFIED`);
      }

      const order = JSON.parse(req.body.toString('utf8'));

      if (!isShopAllowed(shop)) {
        if (rejectCount) rejectCount.shop_blocked++;
        console.warn(`[shopify-webhook] blocked shop: ${shop}`);
        return res.status(200).send('ok');
      }

      // COD detection — payment_gateway_names can be an array OR a string.
      // Normalize each entry: lowercase + strip non-alphanumerics so
      // "Cash on Delivery", "cash-on-delivery", "cashondelivery" and "COD"
      // all reduce to "cashondelivery" / "cod" (see issue #9).
      const gatewayList = Array.isArray(order.payment_gateway_names)
        ? order.payment_gateway_names
        : [order.payment_gateway_names || order.gateway || ''];
      const normalize = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const isCod = gatewayList.some(g => {
        const n = normalize(g);
        return n === 'cod' || n.includes('cashondelivery');
      }) || (order.note_attributes || []).some(a =>
        (a.name || a.key) === 'Payment Gateway' && (a.value === '-' || !a.value)
      );

      if (!isCod) {
        console.log(`[shopify] ${order.name} prepaid — skipping`);
        return res.status(200).send('ok (prepaid)');
      }

      const fresh = isOrderFresh(order);
      if (!fresh.fresh) {
        console.log(`[shopify] ${order.name} (${shop}) skipped stale — ${fresh.reason}`);
        return res.status(200).send(`ok (stale: ${fresh.reason})`);
      }

      const rawPhone = order.customer?.phone || order.shipping_address?.phone || order.billing_address?.phone;
      const phone = normalizePhone(rawPhone);
      if (!phone) {
        console.warn(`[shopify] ${order.name} phone invalid/missing (raw=${JSON.stringify(rawPhone)}) — skipping`);
        return res.status(200).send('ok (no phone)');
      }

      const customerName = [order.customer?.first_name, order.customer?.last_name].filter(Boolean).join(' ').trim() || 'Customer';
      // Declare order identifiers BEFORE the payload that references orderName
      // (was a temporal-dead-zone ReferenceError: payload used orderName before
      // its `const` declaration → every COD order threw → 500 → never queued).
      const orderId = String(order.id);
      const orderName = order.name || `#${order.order_number}`;
      const payload = {
        customer_name: customerName,
        order_number:  orderName,
        total_amount:  String(Math.round(Number(order.current_total_price || order.total_price || 0))),
        product_name:  describeOrderProducts(order.line_items),
        delivery_city: order.shipping_address?.city || '',
        delivery_area: order.shipping_address?.address1 || '',
      };

      const scheduledAt = computeScheduledAt(new Date(), CALL_DELAY_MS);

      // Idempotent upsert on (shop, orderId). Shopify retries failed webhooks
      // up to 48h; this prevents duplicate calls.
      await prisma.scheduledCall.upsert({
        where:  { shop_orderId: { shop, orderId } },
        update: {}, // if row already exists, don't disturb it (already scheduled or terminal)
        create: {
          profile: 'cod-confirm',
          shop, orderId, orderName, phone,
          lang: 'hi-IN',
          payload,
          scheduledAt,
          status: 'queued',
        },
      });

      // DASH-VOICE-1 (2026-05-26): mirror the enqueue into the hub
      // per-brand voice queue so this brand's voice data shows up in
      // its own Mesh Pilot brand space. Best-effort; a failure here
      // must not block the local enqueue or the 200 to Shopify.
      enqueueHubVoiceCall({
        shop,
        phone,
        customer_name: payload.customer_name,
        order_id: orderId,
        order_name: orderName,
        payload,
        scheduled_for: scheduledAt,
      }).catch(err => console.warn(
        `[shopify] hub voice-queue mirror failed shop=${shop} order=${orderName} reason=${err?.message}`,
      ));

      const delaySec = Math.round((scheduledAt.getTime() - Date.now()) / 1000);
      console.log(`[shopify] queued ${orderName} (${shop}) → ${scheduledAt.toISOString()} (+${delaySec}s)${isDnd(new Date(Date.now() + CALL_DELAY_MS)) ? ' [DND-rolled]' : ''}`);
      res.status(200).send('ok (queued)');
    } catch (err) {
      console.error('[shopify-webhook] error', err);
      res.status(500).send('internal error');
    }
  });

  return router;
}
