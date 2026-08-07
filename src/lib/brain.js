/**
 * BSK-005 Voice/COD → brain bridge (GROW-BIND-4, 2026-05-18).
 *
 * Mirrors every completed COD-confirm call onto the shared
 * glitch-brain-mcp so sibling agents on the same brand can see what
 * Voice just did via team_state / recent_activity / briefing.
 *
 * This is **additive**: the existing `CallAttempt` row in the
 * cod_confirm Postgres database (via Prisma) stays as the agent's
 * primary record. The brain mirror is the sibling-visible
 * coordination layer.
 *
 * Wiring contract (BIND-1b multi-brand pattern, adapted for JS):
 *   - Env GLITCH_BRAIN_MCP_URL overrides the brain URL.
 *   - Per-brand tokens: BRAIN_TOKEN_BSK_005_<BRAND_SLUG_UPPER>.
 *     Brand identifier flows from the call's `shop` field (slug-form;
 *     e.g. "glitch-executor" → BRAIN_TOKEN_BSK_005_GLITCH_EXECUTOR).
 *   - Legacy bare BRAIN_TOKEN_BSK_005 fallback.
 *   - Unknown / null brand → silent no-op.
 *   - All brain calls are fire-and-forget; brain failures NEVER
 *     block or fail the local CallAttempt row update.
 *
 * Per the brands × agents matrix in memory, BSK-005 is currently
 * enrolled only for glitch-executor — single-brand today, but the
 * env-driven design covers future enrolments without code change.
 *
 * JS-side: we use the JS distribution of @modelcontextprotocol/sdk
 * directly here (instead of importing @glitch-grow/brain-client
 * from agents/brain-client-ts/, which is a TypeScript wrapper).
 * cod_confirm is pure ESM JS and doesn't have a TS toolchain.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const DEFAULT_BRAIN_URL = "http://127.0.0.1:3107/mcp";
const BRAIN_TOKEN_PREFIX = "BRAIN_TOKEN_BSK_005_";
const BRAIN_TOKEN_LEGACY = "BRAIN_TOKEN_BSK_005";
const BRAIN_URL_ENV = "GLITCH_BRAIN_MCP_URL";

const NON_ENV_CHARS = /[^A-Z0-9_]/g;

/**
 * Normalize a brand/shop slug into the env-key suffix. Accepts
 * kebab ("glitch-executor") and snake ("glitch_executor") forms;
 * both produce UPPER_SNAKE ("GLITCH_EXECUTOR").
 */
export function slugToEnvSuffix(brand) {
  if (!brand) return null;
  let s = String(brand).trim().toUpperCase().replace(/-/g, "_");
  s = s.replace(NON_ENV_CHARS, "");
  return s.length > 0 ? s : null;
}

function brainTokenFor(brand) {
  const suffix = slugToEnvSuffix(brand);
  if (suffix) {
    const perBrand = process.env[BRAIN_TOKEN_PREFIX + suffix];
    if (perBrand) return perBrand;
  }
  const legacy = process.env[BRAIN_TOKEN_LEGACY];
  return legacy || null;
}

function brainUrl() {
  return process.env[BRAIN_URL_ENV] || DEFAULT_BRAIN_URL;
}

export function brainAvailableFor(brand) {
  return brainTokenFor(brand) !== null;
}

function summarizeForBrain(text, maxChars = 240) {
  const t = (text || "").trim().replace(/\n/g, " ");
  if (t.length <= maxChars) return t;
  return t.slice(0, maxChars - 1).replace(/\s+$/, "") + "…";
}

/**
 * Best-effort mirror of one completed CallAttempt to the brain.
 *
 * Called from `scheduler.js` after the prisma.callAttempt.update()
 * that sets the final disposition. Errors caught + logged via
 * console.warn; the local CallAttempt write is never rolled back
 * on brain failure.
 */
// GROW-BIND-HARDENING-1: keep payload under ~32KB serialized.
// Mirrors src/grow_platform/brain/limits.py semantics on the JS side
// so the cap is consistent across all 6 bridges.
const PAYLOAD_MAX_BYTES_JS = 32 * 1024;
const MAX_STRING_VALUE_JS = 2048;
const MAX_LIST_ITEMS_JS = 50;
function _capValue(v) {
  if (typeof v === 'string' && v.length > MAX_STRING_VALUE_JS) {
    return v.slice(0, MAX_STRING_VALUE_JS - 1).replace(/\s+$/, '') + '…';
  }
  if (Array.isArray(v) && v.length > MAX_LIST_ITEMS_JS) {
    return [...v.slice(0, MAX_LIST_ITEMS_JS), { _truncated: `...${v.length - MAX_LIST_ITEMS_JS} more items` }];
  }
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const out = {};
    for (const k of Object.keys(v)) out[k] = _capValue(v[k]);
    return out;
  }
  return v;
}
export function capPayload(payload) {
  if (payload == null) return null;
  const ser = (x) => Buffer.byteLength(JSON.stringify(x, (_k, val) => val ?? null), 'utf8');
  if (ser(payload) <= PAYLOAD_MAX_BYTES_JS) return payload;
  const clipped = {};
  for (const k of Object.keys(payload)) clipped[k] = _capValue(payload[k]);
  if (ser(clipped) <= PAYLOAD_MAX_BYTES_JS) {
    clipped._truncated = 'value-level clip applied';
    return clipped;
  }
  const entries = Object.entries(clipped).map(([k, v]) => [k, v, ser({[k]: v})]);
  entries.sort((a, b) => a[2] - b[2]);
  const kept = {};
  const dropped = [];
  for (const [k, v] of entries) {
    const candidate = { ...kept, [k]: v };
    if (ser(candidate) <= PAYLOAD_MAX_BYTES_JS - 128) kept[k] = v;
    else dropped.push(k);
  }
  kept._truncated = `dropped fields: ${dropped.join(',')}`;
  return kept;
}

export async function mirrorCallCompletionToBrain({
  brand,
  shop,
  orderId,
  orderName,
  disposition,
  attemptId,
  notes,
}) {
  const token = brainTokenFor(brand);
  if (!token) return;

  const summaryParts = [
    `${disposition || "completed"} call`,
    orderName ? `order ${orderName}` : null,
    shop ? `shop ${shop}` : null,
  ].filter(Boolean);

  let transport = null;
  let client = null;
  try {
    transport = new StreamableHTTPClientTransport(new URL(brainUrl()), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    client = new Client(
      { name: "glitch-cod-confirm-brain-bridge", version: "0.1.0" },
      { capabilities: {} },
    );
    await client.connect(transport);
    await client.callTool({
      name: "append_activity",
      arguments: {
        action: "voice.call_completed",
        summary: summarizeForBrain(summaryParts.join(" — ")),
        subject: shop || null,
        payload: capPayload({
          shop: shop || null,
          order_id: orderId || null,
          order_name: orderName || null,
          disposition: disposition || null,
          attempt_id: attemptId || null,
          notes: notes || null,
        }),
        agent_sku: "BSK-005",
      },
    });
  } catch (err) {
    const msg = String(err && err.message || err).toLowerCase();
    if (msg.includes("401") || msg.includes("unauthorized") || msg.includes("unauthenticated")) {
      const suffix = slugToEnvSuffix(brand) || "<unknown>";
      console.warn(
        `[cod_confirm] brain mirror auth failed for brand=${JSON.stringify(brand)} ` +
          `(BSK-005); check env var ${BRAIN_TOKEN_PREFIX}${suffix} or legacy ${BRAIN_TOKEN_LEGACY}`,
      );
    } else {
      console.warn(`[cod_confirm] brain mirror failed: ${err && err.message || err}`);
    }
  } finally {
    try { await client?.close(); } catch { /* ignore */ }
    try { await transport?.close(); } catch { /* ignore */ }
  }
}

/**
 * Schedule a brain mirror without awaiting. Use after a successful
 * prisma.callAttempt.update() so the scheduler's main path doesn't
 * wait on brain I/O.
 */
export function scheduleCallCompletionMirror(opts) {
  if (!brainAvailableFor(opts && opts.brand)) return;
  Promise.resolve()
    .then(() => mirrorCallCompletionToBrain(opts))
    .catch(() => { /* mirror already swallows; double-safety */ });
}
