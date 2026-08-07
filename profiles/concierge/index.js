/**
 * Concierge profile mount — registers the generic terminal-tool endpoints the
 * agent calls to record a call's outcome. Unlike cod-confirm there is no
 * Shopify writeback; the outcome is just persisted on the ScheduledCall row so
 * the scheduler treats the call as resolved (and the cockpit/turn-log captures
 * the conversation).
 *
 * Contract: the engine calls `mount(app, deps)` once at boot for every profile
 * that exports it. `deps` is the shared dependency bag from src/server.js
 * (prisma, markScheduledCallOutcome, requireToolAuth, …).
 */
import express from 'express';

// Map each terminal tool's POST body → a { outcome, notes } pair to persist.
const OUTCOME_FROM = {
  complete_call:    (b) => ({ outcome: (b.outcome || 'completed').slice(0, 40), notes: b.summary || '' }),
  request_callback: (b) => ({ outcome: 'callback',  notes: b.preferred_time || '' }),
  escalate_human:   (b) => ({ outcome: 'escalated', notes: b.reason || '' }),
};

export function mount(app, deps) {
  const { prisma, markScheduledCallOutcome, requireToolAuth } = deps;
  const router = express.Router();

  async function handle(req, res, name) {
    const b = req.body || {};
    const shop = b.shop;
    const orderId = b.entity_ref;
    if (!shop || !orderId) {
      return res.status(400).json({ ok: false, error: 'missing shop/entity_ref' });
    }
    const { outcome, notes } = OUTCOME_FROM[name](b);
    try {
      await markScheduledCallOutcome(prisma, { shop, orderId, outcome, notes });
      console.log(`[concierge] ${name} → outcome=${outcome} shop=${shop} ref=${orderId}`);
      res.json({ ok: true, outcome });
    } catch (err) {
      console.error(`[concierge-tool] ${name} error:`, err);
      res.status(500).json({ ok: false, error: err.message });
    }
  }

  // Mounted at the shared tool base. Tool NAMES are unique per profile, so the
  // cod-confirm and concierge routers coexist here (each next()s unknown paths).
  for (const name of Object.keys(OUTCOME_FROM)) {
    router.post(`/${name}`, requireToolAuth, (req, res) => handle(req, res, name));
  }
  app.use('/webhook/livekit/tool', express.json(), router);

  return {};
}
