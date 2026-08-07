/**
 * Concierge profile — a general-purpose, multi-talented English voice agent for
 * international (US/+1) calls placed over the Twilio SIP trunk.
 *
 * The engine (src/livekit-agent.js) is profile-agnostic. It imports this module
 * and calls the same contract every profile implements:
 *   renderContext(attrs, lang, env)  → ctx (vars dict)
 *   buildSystemPrompt(ctx, lang)     → instructions string
 *   buildWelcome(ctx, lang, env)     → first thing the agent says
 *   buildReprompt(ctx, lang)         → spoken nudge on silence
 *   buildTools(ctx, deps)            → { name: llm.tool(...) } map
 *   turnPersistKey(ctx)              → { shop, shopify_order_id } for turn log
 *   TERMINAL_TOOLS                   → Set<string> — auto-hangup arms after these
 *
 * What makes it "multi-talented": the call's PURPOSE is not hard-coded. The
 * dispatcher passes `goal` (what to accomplish) + free-form `context` in the
 * payload, and the system prompt is templated around them. The same agent can
 * confirm a delivery, follow up on a cart, qualify a lead, or handle support —
 * decided per call, not per profile.
 */
import { z } from 'zod';
import { llm } from '@livekit/agents';

export const TERMINAL_TOOLS = new Set([
  'complete_call',
  'request_callback',
  'escalate_human',
]);

export function renderContext(attrs, lang, env) {
  return {
    agent_name:    attrs.agent_name    || env.CONCIERGE_AGENT_NAME || 'Alex',
    brand_name:    attrs.brand_name    || attrs.store_name || env.STORE_NAME || 'our team',
    customer_name: attrs.customer_name || '',
    // The per-call mission. Free text from the dispatcher, e.g. "Confirm the
    // delivery address for order #1234 and the preferred delivery day."
    goal:          attrs.goal          || 'have a brief, friendly check-in and note anything the customer needs',
    // Optional extra facts the agent may reference (order details, lead info…).
    context:       attrs.context       || '',
    // Optional fully-custom opening line. When set, it REPLACES the default
    // welcome (incl. the recording disclosure) — used for natural/demo calls
    // where a warm, casual opener should be the first thing said.
    opening_line:  attrs.opening_line  || '',
    // Identity for outcome/turn persistence.
    shop:          attrs.shop          || '_concierge',
    entity_ref:    attrs.entity_ref    || attrs.shopify_order_id || '',
    entity_name:   attrs.entity_name   || '',
  };
}

export function buildSystemPrompt(v, lang) {
  const hasName = v.customer_name && v.customer_name !== 'Customer';
  const lines = [
    `You are ${v.agent_name}, a warm, professional, and concise voice agent calling on behalf of ${v.brand_name}.`,
    hasName ? `You are speaking with ${v.customer_name}.` : `You do not know the customer's name; do not invent one.`,
    ``,
    `YOUR GOAL FOR THIS CALL:`,
    v.goal,
    ``,
    v.context ? `CONTEXT YOU MAY USE (do not read it out verbatim; reference naturally):\n${v.context}\n` : ``,
    `HOW TO BEHAVE:`,
    `- Speak naturally, like a real person on a US phone call. Short sentences. One question at a time.`,
    `- Lead the conversation toward the goal, but be polite and never pushy.`,
    `- Confirm key facts back to the customer before treating them as settled.`,
    `- If you don't understand after one clarification, don't loop — politely wrap up.`,
    `- Never invent facts (prices, dates, order details) that aren't in the context.`,
    ``,
    `WHEN TO USE TOOLS (call the tool in the SAME response, do not wait a turn):`,
    `- complete_call: the goal is achieved OR the conversation has reached its natural end. Pass a one-line outcome and a short summary.`,
    `- request_callback: the customer asks to be called back at a specific time.`,
    `- escalate_human: the customer needs a human or the request is out of your scope.`,
    `Always call exactly one terminal tool before the call ends.`,
  ].filter(Boolean);
  return lines.join('\n');
}

export function buildWelcome(v, lang, env) {
  // Custom opener wins — lets a demo/natural call start with a warm casual line.
  if (v.opening_line) return v.opening_line;
  const withConsent = (env.RECORDING_CONSENT_DISCLOSURE || 'on').toLowerCase() !== 'off';
  const consent = withConsent ? ' This call may be recorded for quality.' : '';
  const who = (v.customer_name && v.customer_name !== 'Customer') ? ` ${v.customer_name}` : '';
  // Always end on a question so the customer knows to respond.
  return `Hi${who}, this is ${v.agent_name} from ${v.brand_name}.${consent} Do you have a quick minute?`;
}

export function buildReprompt(v, lang) {
  return `Hello, can you still hear me? This is ${v.agent_name} from ${v.brand_name}.`;
}

export function turnPersistKey(v) {
  // Reuse the generic columns the turn log already has.
  return { shop: v.shop || '_concierge', shopify_order_id: v.entity_ref || '' };
}

export function buildTools(v, { WEBHOOK_BASE, TOOL_SECRET }) {
  async function postTool(name, payload) {
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
          entity_ref: v.entity_ref,
          entity_name: v.entity_name,
          ...payload,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok !== true) {
        console.error(`[concierge-tool ${name}] FAILED http=${res.status} ok=${data.ok}:`, data);
        return `Tool ${name} failed: ${data.error || `HTTP ${res.status}`}. Do NOT tell the customer it succeeded.`;
      }
      return `Tool ${name} OK.`;
    } catch (err) {
      console.error(`[concierge-tool ${name}] error:`, err);
      return `Tool ${name} errored: ${err.message}. Do NOT tell the customer it succeeded.`;
    }
  }

  return {
    complete_call: llm.tool({
      description:
        'Call when the goal is achieved OR the conversation has reached its natural end. Record the outcome and a short summary.',
      parameters: z.object({
        outcome: z.string().describe('Short machine-friendly outcome, e.g. "goal_met", "declined", "not_interested", "info_collected".'),
        summary: z.string().describe('One or two sentences summarising what was decided/collected on the call.'),
      }),
      execute: async ({ outcome, summary }) => postTool('complete_call', { outcome, summary }),
    }),

    request_callback: llm.tool({
      description: 'Call when the customer asks to be called back at a specific time.',
      parameters: z.object({
        preferred_time: z.string().describe('Customer-stated time, e.g. "tomorrow after 5pm".'),
      }),
      execute: async ({ preferred_time }) => postTool('request_callback', { preferred_time }),
    }),

    escalate_human: llm.tool({
      description: 'Call when the customer needs a human or the request is out of scope.',
      parameters: z.object({
        reason: z.string().describe('Why a human is needed / what the customer wants.'),
      }),
      execute: async ({ reason }) => postTool('escalate_human', { reason }),
    }),
  };
}
