// Backfill: enqueue COD-confirm calls for every actionable COD order placed on
// a given day (IST) across the 4 Urban-family stores. For orders that arrived
// before the orders/create webhook was live, or outside the 6h freshness window
// the live webhook enforces.
//
// Usage:
//   node scripts/backfill-cod-day.mjs [YYYY-MM-DD]          # DRY RUN (default) — counts only
//   node scripts/backfill-cod-day.mjs [YYYY-MM-DD] --live   # actually enqueue
//
// Safety:
//   - DRY by default. Pass --live to write scheduledCall rows.
//   - Idempotent: upsert on (shop, orderId) — never disturbs an existing row
//     (already queued / dispatched / done), so no double-calls.
//   - Skips orders already actioned (cod-confirmed/cod-cancelled/cod-no-answer/
//     cod-agent-needed tag), cancelled orders, and orders with no valid phone.
//   - scheduledAt = now; the live scheduler still enforces per-store DND
//     (10:05–20:00 IST) and the shared-API concurrency cap at dispatch time.

import { PrismaClient } from '@prisma/client';
import { normalizePhone } from '../src/lib/phone.js';
import { enqueueHubVoiceCall } from '../src/lib/hub-voice-queue.js';
import { auditShopRegistryAgainstHub } from '../src/lib/hub-context.js';

const prisma = new PrismaClient();

const SHOPS = [
  { domain: 'f51039.myshopify.com',    label: 'Urban Classics' },
  { domain: 'ys4n0u-ys.myshopify.com', label: 'Storico'        },
  { domain: '52j1ga-hz.myshopify.com', label: 'Classicoo'      },
  { domain: 'acmsuy-g0.myshopify.com', label: 'Trendsetters'   },
];

const DAY = process.argv[2] && /^\d{4}-\d{2}-\d{2}$/.test(process.argv[2]) ? process.argv[2] : '2026-06-04';
const LIVE = process.argv.includes('--live');

// Day boundaries in IST (UTC+05:30).
const [Y, M, D] = DAY.split('-').map(Number);
const startIST = `${DAY}T00:00:00+05:30`;
const endDate  = new Date(Date.UTC(Y, M - 1, D + 1));
const endIST   = `${endDate.toISOString().slice(0, 10)}T00:00:00+05:30`;

const ACTIONED_TAGS = new Set(['cod-confirmed', 'cod-cancelled', 'cod-no-answer', 'cod-agent-needed', 'cod-callback-requested']);

function isCod(gateways, tags) {
  const g = (gateways || []).join(',').toLowerCase().replace(/[^a-z0-9,]/g, '');
  if (g.includes('cod') || g.includes('cashondelivery')) return true;
  return (tags || []).some(t => String(t).toLowerCase() === 'cod');
}

function describeProducts(lineItems) {
  const items = (lineItems || []).filter(li => li && li.title);
  if (!items.length) return 'your order';
  const fmt = li => { const q = Number(li.quantity) || 1; return q > 1 ? `${li.title} (x${q})` : li.title; };
  if (items.length <= 3) return items.map(fmt).join(', ');
  return `${items.slice(0, 3).map(fmt).join(', ')} and ${items.length - 3} more`;
}

async function fetchDayOrders(shop, token) {
  const out = [];
  let cursor = null;
  for (let page = 0; page < 20; page++) { // safety cap 20×250 = 5000 orders/day
    const after = cursor ? `, after: "${cursor}"` : '';
    const q = `query {
      orders(first: 250, sortKey: CREATED_AT${after},
             query: "created_at:>='${startIST}' created_at:<'${endIST}'") {
        pageInfo { hasNextPage endCursor }
        edges { node {
          id name createdAt cancelledAt displayFulfillmentStatus displayFinancialStatus
          legacyResourceId
          totalPriceSet { shopMoney { amount } }
          paymentGatewayNames tags
          customer { firstName lastName }
          shippingAddress { phone city address1 }
          billingAddress { phone }
          phone
          lineItems(first: 20) { edges { node { title quantity } } }
        } }
      }
    }`;
    const r = await fetch(`https://${shop}/admin/api/2024-10/graphql.json`, {
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: q }),
    });
    const j = await r.json();
    if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 200));
    const conn = j.data.orders;
    for (const e of conn.edges) out.push(e.node);
    if (!conn.pageInfo.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }
  return out;
}

(async () => {
  console.log(`\n=== COD backfill for ${DAY} IST — mode: ${LIVE ? '🟢 LIVE (enqueue)' : '🔒 DRY RUN (counts only)'} ===\n`);
  // Populate the canonical shop→brand_id cache so the hub mirror tags rows.
  await auditShopRegistryAgainstHub(SHOPS.map(s => s.domain));

  const totals = { total: 0, cod: 0, enqueued: 0, skipNoPhone: 0, skipActioned: 0, skipCancelled: 0, skipExisting: 0 };

  for (const s of SHOPS) {
    const sess = await prisma.session.findFirst({ where: { shop: s.domain, isOnline: false } });
    if (!sess?.accessToken) { console.log(`${s.label.padEnd(15)} | NO TOKEN`); continue; }
    let orders;
    try { orders = await fetchDayOrders(s.domain, sess.accessToken); }
    catch (e) { console.log(`${s.label.padEnd(15)} | FETCH ERROR: ${e.message}`); continue; }

    let cod = 0, enq = 0, noPhone = 0, actioned = 0, cancelled = 0, existing = 0;
    for (const o of orders) {
      totals.total++;
      const tags = o.tags || [];
      if (!isCod(o.paymentGatewayNames, tags)) continue;
      cod++; totals.cod++;
      if (o.cancelledAt) { cancelled++; totals.skipCancelled++; continue; }
      if (tags.some(t => ACTIONED_TAGS.has(String(t).toLowerCase()))) { actioned++; totals.skipActioned++; continue; }
      const phone = normalizePhone(o.shippingAddress?.phone || o.phone || o.billingAddress?.phone || o.customer?.phone);
      if (!phone) { noPhone++; totals.skipNoPhone++; continue; }

      const orderId = String(o.legacyResourceId || o.id.split('/').pop());
      const orderName = o.name || `#${orderId}`;
      const existingRow = await prisma.scheduledCall.findUnique({ where: { shop_orderId: { shop: s.domain, orderId } } });
      if (existingRow) { existing++; totals.skipExisting++; continue; }

      const lineItems = (o.lineItems?.edges || []).map(e => e.node);
      const payload = {
        customer_name: `${o.customer?.firstName || ''} ${o.customer?.lastName || ''}`.trim() || 'Customer',
        total_amount:  String(Math.round(Number(o.totalPriceSet?.shopMoney?.amount || 0))),
        product_name:  describeProducts(lineItems),
        delivery_city: o.shippingAddress?.city || '',
        delivery_area: o.shippingAddress?.address1 || '',
      };

      if (LIVE) {
        await prisma.scheduledCall.create({
          data: { profile: 'cod-confirm', shop: s.domain, orderId, orderName, phone, lang: 'hi-IN', payload, scheduledAt: new Date(), status: 'queued' },
        });
        enqueueHubVoiceCall({ shop: s.domain, phone, customer_name: payload.customer_name, order_id: orderId, order_name: orderName, payload, scheduled_for: new Date() })
          .catch(err => console.warn(`   hub mirror failed ${orderName}: ${err?.message}`));
      }
      enq++; totals.enqueued++;
    }
    console.log(`${s.label.padEnd(15)} | orders=${orders.length} cod=${cod} → ${LIVE ? 'enqueued' : 'would enqueue'}=${enq}  (skip: existing=${existing} actioned=${actioned} cancelled=${cancelled} no-phone=${noPhone})`);
  }

  console.log(`\n=== TOTAL: ${LIVE ? 'enqueued' : 'would enqueue'} ${totals.enqueued} call(s) | ${totals.cod} COD of ${totals.total} orders | skipped: existing=${totals.skipExisting} actioned=${totals.skipActioned} cancelled=${totals.skipCancelled} no-phone=${totals.skipNoPhone} ===`);
  if (!LIVE) console.log('Re-run with --live to enqueue. The scheduler still enforces DND (10:05–20:00 IST) + concurrency at dispatch.\n');
  await prisma.$disconnect();
})();
