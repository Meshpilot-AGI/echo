/**
 * COD-confirm tool router — the 4 terminal tools Priya calls mid-conversation.
 *
 *   POST /webhook/livekit/tool/confirm_order
 *   POST /webhook/livekit/tool/cancel_order
 *   POST /webhook/livekit/tool/request_human_agent
 *   POST /webhook/livekit/tool/request_callback
 *
 *   POST /webhook/retell/tool/confirm_order
 *   POST /webhook/retell/tool/cancel_order
 *   POST /webhook/retell/tool/request_human_agent
 *   POST /webhook/retell/tool/request_callback
 *
 * Each tool:
 *   1. authenticates via shared-secret header (LIVEKIT_TOOL_SECRET)
 *   2. writes the corresponding tag to the Shopify order
 *   3. records the outcome on the ScheduledCall row (atomic update via scheduler)
 *   4. returns { ok, tag_applied } so the agent can confirm to the customer
 *
 * Profile-local because the *fact* that a successful tool call writes a
 * Shopify tag is COD-confirm-specific. Other profiles will export their own
 * tools router with their own side effects (Calendar event, CRM lead row, ...).
 */
import express from 'express';
import crypto from 'node:crypto';
import { updateOrderTag } from '../lib/shopify-tags.js';

export const TOOL_TO_OUTCOME = {
  confirm_order:       'confirmed',
  cancel_order:        'cancelled',
  request_human_agent: 'agent_needed',
  request_callback:    'callback_requested',
};

export const OUTCOME_TO_TAG = {
  confirmed:          'cod-confirmed',
  cancelled:          'cod-cancelled',
  agent_needed:       'cod-agent-needed',
  callback_requested: 'cod-callback-requested',
  no_answer:          'cod-no-answer',
};

const NOTE_BUILDERS = {
  confirm_order:       b => `COD confirmed via Priya. ${b.note || ''}`.trim(),
  cancel_order:        b => `COD cancelled via Priya. Reason: ${b.reason || 'not given'}`,
  request_human_agent: b => `Customer needs human agent. Note: ${b.note || ''}`,
  request_callback:    b => `Customer asked callback: ${b.when || 'time not specified'}`,
};

function createAuthMiddleware({ env, rejectCount, label }) {
  const LIVEKIT_TOOL_SECRET = env.LIVEKIT_TOOL_SECRET || '';
  return function requireAuth(req, res, next) {
    if (!LIVEKIT_TOOL_SECRET) {
      console.warn(`[${label}-tool] LIVEKIT_TOOL_SECRET not configured — rejecting`);
      return res.status(503).json({ ok: false, error: 'tool auth not configured' });
    }
    const got = req.get('X-COD-Tool-Secret') || '';
    if (!got) {
      if (rejectCount) rejectCount.tool_auth_missing++;
      return res.status(401).json({ ok: false, error: 'missing X-COD-Tool-Secret' });
    }
    const a = Buffer.from(got);
    const b = Buffer.from(LIVEKIT_TOOL_SECRET);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      if (rejectCount) rejectCount.tool_auth_mismatch++;
      return res.status(401).json({ ok: false, error: 'invalid X-COD-Tool-Secret' });
    }
    next();
  };
}

async function handleTool({ prisma, markScheduledCallOutcome, toolName, body }) {
  console.log(`[cod-tool] ${toolName} body:`, JSON.stringify(body).slice(0, 400));
  const shop = body.shop;
  const orderId = body.shopify_order_id;
  if (!shop || !orderId) {
    throw Object.assign(new Error('missing shop/shopify_order_id'), { status: 400 });
  }

  const outcome = TOOL_TO_OUTCOME[toolName];
  const tag = OUTCOME_TO_TAG[outcome];
  const note = NOTE_BUILDERS[toolName](body);

  await updateOrderTag(prisma, { shop, orderId, tag, note });
  await markScheduledCallOutcome(prisma, { shop, orderId, outcome, notes: note });
  return { ok: true, tag_applied: tag, order_name: body.order_name };
}

/**
 * LiveKit agent worker sends a flat JSON body:
 *   { shop, shopify_order_id, note?, reason?, when?, order_name? }
 */
export function createToolsRouter({ prisma, markScheduledCallOutcome, env, rejectCount }) {
  const router = express.Router();
  const requireAuth = createAuthMiddleware({ env, rejectCount, label: 'livekit' });

  async function handle(req, res, toolName) {
    try {
      const result = await handleTool({ prisma, markScheduledCallOutcome, toolName, body: req.body || {} });
      res.json(result);
    } catch (err) {
      console.error('[livekit-tool]', toolName, 'error:', err);
      const status = err.status || 500;
      res.status(status).json({ ok: false, error: err.message });
    }
  }

  router.post('/confirm_order',       requireAuth, (req, res) => handle(req, res, 'confirm_order'));
  router.post('/cancel_order',        requireAuth, (req, res) => handle(req, res, 'cancel_order'));
  router.post('/request_human_agent', requireAuth, (req, res) => handle(req, res, 'request_human_agent'));
  router.post('/request_callback',    requireAuth, (req, res) => handle(req, res, 'request_callback'));

  router.requireAuth = requireAuth;
  return router;
}

/**
 * Retell sends a nested JSON body:
 *   {
 *     "call": { "call_id": "...", "metadata": { "shop": "...", "order_id": "..." } },
 *     "name": "confirm_order",
 *     "parameters": { "note": "..." }
 *   }
 * We translate it to the same flat shape the shared handler expects.
 */
export function createRetellToolsRouter({ prisma, markScheduledCallOutcome, env, rejectCount }) {
  const router = express.Router();
  const requireAuth = createAuthMiddleware({ env, rejectCount, label: 'retell' });

  function normalizeRetellBody(raw) {
    const call = raw?.call || {};
    const meta = call?.metadata || {};
    const params = raw?.parameters || raw?.args || {};
    return {
      shop: meta.shop || raw?.shop,
      shopify_order_id: meta.order_id || raw?.order_id || raw?.shopify_order_id,
      order_name: meta.order_name || raw?.order_name,
      note: params.note,
      reason: params.reason,
      when: params.when,
    };
  }

  async function handle(req, res, toolName) {
    const raw = req.body || {};
    // Retell expects a specific response shape. Return the result object so
    // the agent can confirm to the customer. Non-2xx fails the tool call.
    try {
      const body = normalizeRetellBody(raw);
      const result = await handleTool({ prisma, markScheduledCallOutcome, toolName, body });
      res.json({
        result: `Applied tag ${result.tag_applied} to order ${result.order_name || body.shopify_order_id}`,
      });
    } catch (err) {
      console.error('[retell-tool]', toolName, 'error:', err);
      const status = err.status || 500;
      res.status(status).json({ error: err.message });
    }
  }

  router.post('/confirm_order',       requireAuth, (req, res) => handle(req, res, 'confirm_order'));
  router.post('/cancel_order',        requireAuth, (req, res) => handle(req, res, 'cancel_order'));
  router.post('/request_human_agent', requireAuth, (req, res) => handle(req, res, 'request_human_agent'));
  router.post('/request_callback',    requireAuth, (req, res) => handle(req, res, 'request_callback'));

  router.requireAuth = requireAuth;
  return router;
}
