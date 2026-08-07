/**
 * Dev-only PSTN call trigger keyed by an existing Shopify order name.
 *
 *   GET /flow-test-livekit?shop=...&order=%231234&phone=+91XXXXXXXXXX&lang=hi-IN
 *
 * Bypasses the scheduler + DND so an engineer can dial their own phone with
 * a real order's context for QA. Lives in the COD-confirm profile because it
 * fetches Shopify-shaped data. Future profiles would ship their own equivalent
 * keyed on their own primary entity (calendar event, lead, ticket).
 *
 * Factory: createFlowTestRouter({ prisma, normalizePhone, triggerLivekitCall,
 *   getShopBranding }).
 */
import express from 'express';
import { fetchShopifyOrderByName } from '../lib/shopify-order-fetch.js';

export function createFlowTestRouter({ prisma, normalizePhone, triggerLivekitCall, getShopBranding }) {
  const router = express.Router();

  router.get('/flow-test-livekit', async (req, res) => {
    try {
      const shop = req.query.shop;
      const orderName = (req.query.order || '').toString();
      const phoneRaw = (req.query.phone || '').toString();
      const lang = req.query.lang === 'en-IN' ? 'en-IN' : 'hi-IN';

      if (!shop || !orderName) {
        return res.status(400).send('Pass ?shop=...myshopify.com&order=%238917&phone=+91XXXXXXXXXX');
      }

      const phone = normalizePhone(phoneRaw);
      if (!phone) return res.status(400).send(`Invalid phone: ${phoneRaw}`);

      const order = await fetchShopifyOrderByName(prisma, shop, orderName);
      const branding = getShopBranding(shop);
      const result = await triggerLivekitCall({
        phone,
        order: { ...order, shop, storeName: branding.name, storeCategory: branding.category },
        lang,
      });
      res.json({ ok: true, livekit: result, lang, context_sent: order });
    } catch (e) {
      console.error('[flow-test-livekit]', e);
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}
