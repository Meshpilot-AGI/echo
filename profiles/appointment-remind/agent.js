/**
 * appointment-remind profile — agent-time module.
 *
 * Mirrors the contract that profiles/cod-confirm/agent.js defines. The
 * engine calls the same six exports for any profile; everything specific
 * to appointment reminders lives here.
 */
import { z } from 'zod';
import { llm } from '@livekit/agents';
import { loadPromptTemplate, renderTemplate } from '../../src/lib/prompts.js';

const PROFILE_DIR = new URL('.', import.meta.url).pathname;

export const TERMINAL_TOOLS = new Set([
  'confirm_appointment',
  'reschedule_appointment',
  'cancel_appointment',
  'request_human_agent',
]);

/**
 * Translate raw LiveKit participant attributes (set by trigger-livekit-call
 * via the participantAttributes map) into a context object the other
 * builders consume. For appointment-remind we expect:
 *   appointment_id, customer_name, provider_name, appointment_date,
 *   appointment_time, service_name, location
 */
export function renderContext(attrs, lang, env) {
  return {
    appointment_id:    attrs.appointment_id    || '',
    customer_name:     attrs.customer_name     || '',
    provider_name:     attrs.provider_name     || env.PROVIDER_NAME || 'our clinic',
    appointment_date:  attrs.appointment_date  || '',
    appointment_time:  attrs.appointment_time  || '',
    service_name:      attrs.service_name      || '',
    location:          attrs.location          || '',
  };
}

export function buildSystemPrompt(v, lang) {
  const isEn = lang === 'en-IN';
  const have = k => v[k] && String(v[k]).trim().length > 0;
  const hasName = have('customer_name');

  const vars = {
    provider_name:           v.provider_name,
    customer_name_phrase:    hasName ? v.customer_name : (isEn ? 'the customer' : 'ग्राहक'),
    customer_name_addressed: hasName ? (isEn ? v.customer_name : `${v.customer_name} जी`)
                                     : (isEn ? 'there' : 'जी'),
    appointment_date_phrase: have('appointment_date') ? v.appointment_date
                                                      : (isEn ? 'the booked date' : 'booked date'),
    appointment_time_phrase: have('appointment_time') ? v.appointment_time
                                                      : (isEn ? 'the booked time' : 'booked time'),
    service_phrase:          have('service_name') ? v.service_name
                                                  : (isEn ? 'your appointment' : 'आपकी appointment'),
    location_phrase:         have('location') ? v.location
                                              : (isEn ? 'the usual location' : 'usual location'),
  };

  const tmpl = loadPromptTemplate(PROFILE_DIR, isEn ? 'english-prompt' : 'hindi-prompt');
  return renderTemplate(tmpl, vars);
}

export function buildWelcome(v, lang, env) {
  const hasName = v.customer_name && v.customer_name.trim().length > 0;
  const withConsent = (env.RECORDING_CONSENT_DISCLOSURE || 'on').toLowerCase() !== 'off';

  if (lang === 'en-IN') {
    const address = hasName ? ` ${v.customer_name}` : '';
    const consent = withConsent ? ' This call may be recorded for quality and service improvement.' : '';
    return `Hello${address}, this is Maya calling from ${v.provider_name}. I'm calling about your upcoming appointment.${consent}`;
  }
  const address = hasName ? ` ${v.customer_name} जी` : '';
  const consent = withConsent ? ' यह call quality के लिए record की जा रही है।' : '';
  return `नमस्ते${address}, मैं Maya बोल रही हूँ ${v.provider_name} से। आपकी upcoming appointment के बारे में call किया है।${consent}`;
}

/**
 * Build the 4 tools, each closed over per-call context so the LLM doesn't
 * have to re-pass appointment_id on every invocation.
 *
 * Side effect: each terminal tool POSTs to /webhook/livekit/tool/<name>
 * on the engine server. The appointment-remind profile's index.js mounts
 * those routes; for the PoC they log + return ok and persist nothing.
 * Wire to a real backend (Google Calendar event update, internal scheduler
 * row, CRM hook) when a paying customer ships.
 */
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
          appointment_id: v.appointment_id,
          customer_name:  v.customer_name,
          ...payload,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok !== true) {
        console.error(`[tool ${name}] FAILED http=${res.status} ok=${data.ok}:`, data);
        return `Tool ${name} failed: ${data.error || `HTTP ${res.status}`}. Do NOT tell the customer this succeeded.`;
      }
      return `Tool ${name} OK.`;
    } catch (err) {
      console.error(`[tool ${name}] error:`, err);
      return `Tool ${name} errored: ${err.message}. Do NOT tell the customer this succeeded.`;
    }
  }

  return {
    confirm_appointment: llm.tool({
      description:
        'Call IMMEDIATELY in the same response when the customer confirms attendance ("haan", "yes", "theek hai", "confirm", "I will be there", "ji"). Do NOT wait for a subsequent user turn.',
      parameters: z.object({
        note: z.string().optional().describe('Optional short note from the conversation.'),
      }),
      execute: async ({ note }) => postTool('confirm_appointment', { note }),
    }),

    reschedule_appointment: llm.tool({
      description:
        'Call when the customer asks to change the appointment to a different time but is NOT cancelling outright. Capture their stated preferred new slot verbatim.',
      parameters: z.object({
        preferredTime: z.string().describe(
          'Customer-stated new slot in their own words (e.g. "kal subah 11 baje", "next Wednesday afternoon").',
        ),
      }),
      execute: async ({ preferredTime }) => postTool('reschedule_appointment', { preferred_time: preferredTime }),
    }),

    cancel_appointment: llm.tool({
      description:
        'Call only after the customer has CONFIRMED a cancellation on the re-confirmation turn ("nahi", "cancel", "मुझे नहीं करना"). Capture the reason if offered.',
      parameters: z.object({
        reason: z.string().optional().describe('Short reason; empty string if customer declined to give one.'),
      }),
      execute: async ({ reason }) => postTool('cancel_appointment', { reason: reason || '' }),
    }),

    request_human_agent: llm.tool({
      description:
        'Call when the customer asks for a human / has a clinical or billing question / asks a question you cannot answer / responds unclearly 2+ times.',
      parameters: z.object({
        reason: z.string().describe('Short description of what the customer needs human help with.'),
      }),
      execute: async ({ reason }) => postTool('request_human_agent', { reason }),
    }),
  };
}

/**
 * Key included in every /webhook/livekit/turn body so transcripts can be
 * joined back to the appointment. Uses the engine's COD-shaped key for
 * compatibility with the current /webhook/livekit/turn endpoint:
 * `shop` is sentinel-valued ('_appointment-remind') and `shopify_order_id`
 * carries the appointment id. Phase 5+ will generalize the endpoint to
 * accept (profile, entity_ref) directly.
 */
export function turnPersistKey(v) {
  if (!v.appointment_id) return null;
  return {
    shop: '_appointment-remind',
    shopify_order_id: v.appointment_id,
  };
}
