/**
 * cod-confirm profile — agent-time module.
 *
 * Engine (src/livekit-agent.js) is profile-agnostic. It imports this module
 * dynamically (using the profile's _dir from the registry) and calls the
 * exported builders to assemble the per-call AgentSession components:
 *
 *   renderContext(attrs, lang, env)      → ctx (vars dict + identity)
 *   buildSystemPrompt(ctx, lang)         → instructions string
 *   buildWelcome(ctx, lang, env)         → first thing the agent says
 *   buildTools(ctx, deps)                → { name: llm.tool(...) } map
 *   turnPersistKey(ctx)                  → { shop, shopify_order_id } for /webhook/livekit/turn
 *   TERMINAL_TOOLS                       → Set<string> — auto-hangup arms after these
 *
 * Everything Shopify-, Priya-, or COD-specific lives here. Other profiles
 * supply their own agent.js with the same contract.
 */
import { z } from 'zod';
import { llm } from '@livekit/agents';
import { loadPromptTemplate, renderTemplate } from '../../src/lib/prompts.js';
import { speakableProduct } from './lib/speakable.js';
import { hindiRupees, englishRupees } from './lib/spoken-numbers.js';

const PROFILE_DIR = new URL('.', import.meta.url).pathname;

export const TERMINAL_TOOLS = new Set([
  'confirm_order',
  'cancel_order',
  'request_human_agent',
  'request_callback',
]);

/** "a" / "an" for English category phrases. */
function articleFor(s) {
  return /^[aeiou]/i.test(String(s || '').trim()) ? 'an' : 'a';
}

/**
 * Translate raw LiveKit participant attributes into a context object the
 * other builders consume. Engine passes attrs (set by trigger-livekit-call's
 * SipClient.createSipParticipant), the resolved call language, and
 * process.env (for store-name fallbacks).
 */
export function renderContext(attrs, lang, env) {
  return {
    customer_name:    attrs.customer_name    || 'Customer',
    order_number:     attrs.order_number     || '',
    total_amount:     attrs.total_amount     || '',
    product_name:     attrs.product_name     || 'your order',
    delivery_city:    attrs.delivery_city    || '',
    delivery_area:    attrs.delivery_area    || '',
    shop:             attrs.shop             || '',
    shopify_order_id: attrs.shopify_order_id || '',
    // Neutral fallback only — never the single-tenant STORE_NAME, which in a
    // multi-store deployment would make an unbranded store impersonate another.
    store_name:       attrs.store_name       || 'our store',
    store_category:   attrs.store_category   || env.STORE_CATEGORY || 'online store',
  };
}

export function buildSystemPrompt(v, lang) {
  const have = k => v[k] && String(v[k]).trim().length > 0;
  const ctxLines = [
    have('customer_name')    && `- Customer name: ${v.customer_name}`,
    have('order_number')     && `- Order number: ${v.order_number}`,
    have('total_amount')     && `- Total amount: Rs. ${v.total_amount} (say as spoken words, not digits)`,
    have('product_name')     && `- Product: ${v.product_name}`,
    (have('delivery_area') || have('delivery_city')) &&
      `- Delivery address: ${[v.delivery_area, v.delivery_city].filter(Boolean).join(', ')}`,
  ].filter(Boolean).join('\n');

  const isEn = lang === 'en-IN';
  const fallbackCtx = isEn
    ? `(No order context provided. This is a test / demo call — briefly greet the caller and mention you are Priya from ${v.store_name}; do not invent an order.)`
    : `(No order context. This is a test / demo call — briefly greet the caller and explain you are Priya from ${v.store_name}; do not invent an order.)`;

  const spoken = speakableProduct(v.product_name, lang);

  const vars = {
    store_name:           v.store_name,
    store_category:       v.store_category,
    store_article:        articleFor(v.store_category),
    context_block:        ctxLines || fallbackCtx,
    order_number_phrase:  v.order_number || (isEn ? 'your order' : 'अपना order'),
    product_phrase:       spoken
                            ? (isEn ? `a ${spoken}` : `एक ${spoken}`)
                            : (isEn ? 'your product' : 'अपना product'),
    amount_phrase:        v.total_amount
                            ? (isEn ? englishRupees(v.total_amount) : hindiRupees(v.total_amount))
                            : (isEn ? 'the stated amount' : 'बताया गया amount'),
    address_phrase:       (v.delivery_area || (isEn ? 'your address' : 'आपका address'))
                            + (v.delivery_city ? `, ${v.delivery_city}` : ''),
    call_real_suffix:     v.order_number
                            ? (isEn ? ` I am calling about your order ${v.order_number}.` : ` आपके order number ${v.order_number} के बारे में call की है।`)
                            : '',
  };

  const tmpl = loadPromptTemplate(PROFILE_DIR, isEn ? 'english-prompt' : 'hindi-prompt');
  return renderTemplate(tmpl, vars);
}

export function buildWelcome(v, lang, env) {
  const hasRealName = v.customer_name && v.customer_name !== 'Customer';
  const withConsent = (env.RECORDING_CONSENT_DISCLOSURE || 'on').toLowerCase() !== 'off';
  // Open with a SHORT presence check — do NOT pitch the order here. The agent's
  // prompt delivers the order confirmation (Step 1: product+amount) only AFTER a
  // human responds, so the order details are never spoken into a voicemail
  // (which never answers "haan"). Ends on a clear yes/no so a human knows to
  // reply. Order readback now lives entirely in the LLM-driven flow.
  if (lang === 'en-IN') {
    const address = hasRealName ? ' ' + v.customer_name : '';
    const consent = withConsent ? ' This call may be recorded for quality.' : '';
    return `Hi${address}, this is Priya from ${v.store_name}.${consent} Do you have a quick minute to talk?`;
  }
  const address = hasRealName ? ` ${v.customer_name} जी` : '';
  const consent = withConsent ? ' यह call quality के लिए record की जा रही है।' : '';
  return `नमस्ते${address}, मैं Priya बोल रही हूँ ${v.store_name} से।${consent} क्या आप अभी एक minute बात कर सकते हैं?`;
}

/**
 * Re-prompt spoken when the customer goes silent after the welcome (instead of
 * silently dropping the call). Short, re-asks the confirmation question so a
 * hesitant or distracted customer re-engages.
 */
export function buildReprompt(v, lang) {
  // Presence-only nudge (the order isn't stated until the customer engages).
  if (lang === 'en-IN') {
    return `Hello, are you able to hear me? This is Priya from ${v.store_name}.`;
  }
  return `Hello, क्या आप मुझे सुन पा रहे हैं? मैं Priya बोल रही हूँ ${v.store_name} से।`;
}

/**
 * The 4 Shopify-writing tools, closed over the per-call context so the LLM
 * doesn't have to re-pass shop / order_id / order_name on every invocation.
 *
 * deps: { WEBHOOK_BASE, TOOL_SECRET } — supplied by the engine.
 */
export function buildTools(v, { WEBHOOK_BASE, TOOL_SECRET }) {
  const hasOrderContext = Boolean(v.shop && v.shopify_order_id);

  async function postTool(name, payload) {
    if (!hasOrderContext) {
      console.warn(`[tool ${name}] SKIPPED: no shop/shopify_order_id on this call (likely sandbox)`);
      return `Tool ${name} is unavailable for this call because order context is missing. Do NOT call this tool again. Apologise briefly to the customer and end the call.`;
    }
    const url = `${WEBHOOK_BASE}/webhook/livekit/tool/${name}`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(TOOL_SECRET ? { 'X-COD-Tool-Secret': TOOL_SECRET } : {}),
        },
        body: JSON.stringify({
          shop: v.shop,
          shopify_order_id: v.shopify_order_id,
          order_name: v.order_number,
          ...payload,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok !== true) {
        console.error(`[tool ${name}] FAILED http=${res.status} ok=${data.ok}:`, data);
        return `Tool ${name} failed: ${data.error || `HTTP ${res.status}`}. Do NOT tell the customer this succeeded.`;
      }
      return `Tool ${name} OK. ${data.tag_applied ? `Tag ${data.tag_applied} applied.` : ''}`;
    } catch (err) {
      console.error(`[tool ${name}] error:`, err);
      return `Tool ${name} errored: ${err.message}. Do NOT tell the customer this succeeded.`;
    }
  }

  return {
    confirm_order: llm.tool({
      description:
        'Call IMMEDIATELY in the same response when the customer confirms both product+amount AND address ("haan", "yes", "theek hai", "sahi hai", "ji", "bilkul"). Do NOT wait for a subsequent user turn. This marks the Shopify order cod-confirmed.',
      parameters: z.object({
        note: z.string().optional().describe('Optional short note from the conversation.'),
      }),
      execute: async ({ note }) => postTool('confirm_order', { note }),
    }),

    cancel_order: llm.tool({
      description:
        'Call when the customer clearly refuses the order ("nahi", "cancel", "mujhe nahi chahiye", "galti se ordered", "mana"). Captures the reason for reporting.',
      parameters: z.object({
        reason: z.string().describe(
          'Short reason the customer gave for cancelling (e.g. wrong size, changed mind, ordered by mistake, price too high).',
        ),
      }),
      execute: async ({ reason }) => postTool('cancel_order', { reason }),
    }),

    request_human_agent: llm.tool({
      description:
        'Call when the customer asks for a human / agent / representative, or asks a question you cannot answer (specific refund timing, size exchange), or responds unclearly 2+ times in a row.',
      parameters: z.object({
        note: z.string().describe('Short description of what the customer needs human help with.'),
      }),
      execute: async ({ note }) => postTool('request_human_agent', { note }),
    }),

    request_callback: llm.tool({
      description:
        'Call when the customer says they are busy and asks to be called later. Capture the time they specified.',
      parameters: z.object({
        when: z.string().optional().describe(
          'When the customer wants the callback (e.g. "1 ghante mein", "evening", "kal subah").',
        ),
      }),
      execute: async ({ when }) => postTool('request_callback', { when }),
    }),
  };
}

/**
 * Key that the engine includes in every /webhook/livekit/turn body so the
 * server can join transcript rows to ScheduledCall / CallAttempt. For
 * cod-confirm this is the Shopify shop + order id; other profiles return
 * their own (profile, entityRef) identifiers.
 */
export function turnPersistKey(v) {
  if (!v.shop || !v.shopify_order_id) return null;
  return { shop: v.shop, shopify_order_id: v.shopify_order_id };
}
