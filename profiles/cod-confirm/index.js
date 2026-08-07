/**
 * COD-confirm profile barrel.
 *
 * The engine imports `mount` and calls it once with its dependency bag; the
 * profile registers all its routes (Shopify webhook, 4 terminal tools,
 * dev /flow-test-livekit) under the appropriate paths.
 *
 * Engine boundary: nothing in src/ should import individual files inside this
 * directory. The contract is `mount(app, deps)` plus the named re-exports
 * below (OUTCOME_TO_TAG / updateOrderTag) which the engine's scheduler still
 * needs for the "no-answer after N attempts" final-fail tag-writeback path.
 * Phase 2 will lift that final-fail path behind a profile-callback so the
 * engine stops referencing Shopify even by name.
 */
import express from 'express';
import { createShopifyWebhookRouter } from './triggers/shopify-webhook.js';
import { createToolsRouter, createRetellToolsRouter, OUTCOME_TO_TAG, TOOL_TO_OUTCOME } from './tools/index.js';
import { createFlowTestRouter } from './triggers/flow-test.js';
import { updateOrderTag } from './lib/shopify-tags.js';

export { OUTCOME_TO_TAG, TOOL_TO_OUTCOME, updateOrderTag };

/**
 * Wire all profile-owned HTTP routes into the given Express app.
 *
 * deps = {
 *   prisma,                       // PrismaClient
 *   env,                          // process.env-shaped object
 *   rejectCount,                  // { hmac_missing, hmac_mismatch, shop_blocked,
 *                                 //   tool_auth_missing, tool_auth_mismatch }
 *   CALL_DELAY_MS,                // number
 *   computeScheduledAt,           // from src/lib/dnd.js
 *   isDnd,                        // from src/lib/dnd.js
 *   isShopAllowed,                // from src/lib/shops.js
 *   normalizePhone,               // from src/lib/phone.js
 *   getShopBranding,              // from src/lib/shops.js
 *   triggerLivekitCall,           // from src/trigger-livekit-call.js
 *   markScheduledCallOutcome,     // from src/lib/scheduler.js
 * }
 *
 * Returns the auth middleware so the engine can reuse it for the related
 * /webhook/livekit/turn endpoint and the manual-replay path on the egress
 * webhook (both still live in server.js for now — phase 1c will revisit).
 */
export function mount(app, deps) {
  // Shopify webhook needs the raw body for HMAC verification, so we attach
  // express.raw at the mount path itself rather than in server.js. Keeping
  // body-parser config co-located with the route that needs it makes the
  // engine simpler and means adding new profiles never has to coordinate
  // body-parser ordering with other profiles.
  // Shopify webhook needs raw body for HMAC verify; tool routes need JSON.
  // Attaching both parsers at their own path scope means mount() must be
  // called BEFORE the engine's global express.json (otherwise the global
  // parser consumes the body stream for /webhook/shopify and HMAC fails).
  app.use(
    '/webhook/shopify',
    express.raw({ type: 'application/json' }),
    createShopifyWebhookRouter(deps),
  );

  const toolsRouter = createToolsRouter(deps);
  app.use('/webhook/livekit/tool', express.json(), toolsRouter);

  const retellToolsRouter = createRetellToolsRouter(deps);
  app.use('/webhook/retell/tool', express.json(), retellToolsRouter);

  app.use(createFlowTestRouter(deps));

  return { requireToolAuth: toolsRouter.requireAuth };
}

/**
 * Profile hook: called by the engine's scheduler when a ScheduledCall row
 * fails permanently (max attempts exhausted with no answer). For COD this
 * writes the `cod-no-answer` tag to the Shopify order so the merchant's
 * ops team can see it in the order list.
 *
 * Other profiles export their own onNoAnswer if they need post-failure
 * housekeeping. Missing hook = no-op.
 */
export async function onNoAnswer({ prisma, row, reason }) {
  await updateOrderTag(prisma, {
    shop:    row.shop,
    orderId: row.orderId,
    tag:     OUTCOME_TO_TAG.no_answer,
    note:    `Customer did not answer after ${row.attempts} automated attempts. Last error: ${reason}`,
  });
}
