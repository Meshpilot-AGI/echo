/**
 * Trigger an outbound voice call via Retell AI + Vobiz SIP (custom telephony).
 *
 * The scheduler's dispatchOne() calls this when COD_CONFIRM_RUNTIME=retell.
 * It posts to Retell's /v2/create-phone-call with our imported Vobiz number
 * as from_number and passes the order context as dynamic variables.
 *
 * Returns the same { ok, room_name, sip } shape as triggerLivekitCall and
 * triggerRelayCall so the scheduler's post-placement bookkeeping is unchanged.
 */

// Speech normalization (same helpers the LiveKit path uses): collapse the long
// Shopify SKU to a short spoken noun, and amounts to spoken words — otherwise
// Retell reads the full brand-heavy SKU verbatim and digits awkwardly.
import Retell from 'retell-sdk';
import { speakableProduct } from '../profiles/cod-confirm/lib/speakable.js';
import { hindiNumber } from '../profiles/cod-confirm/lib/spoken-numbers.js';

// Devanagari output, NOT romanized — ElevenLabs mispronounces Latin-script Hindi
// (e.g. "ek hazaar") but reads Devanagari ("एक हज़ार") correctly.
function spokenAmount(v) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? hindiNumber(n) : String(v ?? '');
}

const RETELL_API_KEY = process.env.RETELL_API_KEY || '';
const RETELL_AGENT_ID = process.env.RETELL_AGENT_ID || '';
const RETELL_WEBHOOK_BASE = process.env.COD_CONFIRM_WEBHOOK_BASE || process.env.SERVER_URL || '';

function ensureCreds() {
  const missing = [];
  if (!RETELL_API_KEY) missing.push('RETELL_API_KEY');
  if (!RETELL_AGENT_ID) missing.push('RETELL_AGENT_ID');
  if (!RETELL_WEBHOOK_BASE) missing.push('COD_CONFIRM_WEBHOOK_BASE or SERVER_URL');
  if (missing.length) throw new Error(`Missing env vars: ${missing.join(', ')}`);
}

// Official Retell SDK transport: typed client + automatic retry (2x exp backoff
// on 429/408/409/timeouts/5xx) for more robust outbound dispatch than the raw
// fetch it replaces. We pass the exact same wire payload — the SDK forwards
// every key verbatim (incl. agent_id/webhook_url, which aren't in its typed
// params but our BYOC/Vobiz create-phone-call relies on), so call behavior is
// byte-identical to the previous hand-rolled fetch.
let _retell = null;
function retell() {
  if (!_retell) _retell = new Retell({ apiKey: RETELL_API_KEY });
  return _retell;
}

/**
 * Place an outbound Retell phone call via the imported Vobiz number.
 *
 * @param {object} params
 * @param {string} params.phone           - Recipient phone in E.164
 * @param {string} [params.profile]       - Agent profile id (e.g. 'cod-confirm')
 * @param {object} [params.payload]       - Profile-specific context spread into
 *                                          retell_llm_dynamic_variables.
 * @param {object} [params.identity]      - { shop, entityRef, entityName }
 * @param {object} [params.branding]      - { name, category }
 */
export async function triggerRetellCall({
  phone,
  profile = 'cod-confirm',
  payload = {},
  identity = {},
  branding = {},
}) {
  ensureCreds();
  if (!phone) throw new Error('phone required (E.164)');

  const brandName = branding.name || payload.store_name || payload.brand_name || process.env.STORE_NAME || 'our store';
  const brandCategory = branding.category || payload.store_category || payload.brand_category || process.env.STORE_CATEGORY || 'online store';

  // Build dynamic variables for the Retell LLM prompt.
  const dynamicVariables = {
    customer_name:    payload.customer_name || '',
    order_number:     payload.order_number || payload.orderName || '',
    // Normalize for natural TTS in DEVANAGARI (matches the LiveKit path):
    //   amount  → spoken Hindi words ("एक हज़ार नौ सौ पैंतालीस")
    //   product → short Hindi noun   ("चश्मे", not the full SKU)
    // Devanagari so ElevenLabs pronounces it correctly (Latin Hindi mispronounces).
    // Non-empty fallbacks so a missing value never surfaces as the literal word
    // "product"/blank in the prompt (and so dashboard test-calls still read sanely).
    total_amount:     spokenAmount(payload.total_amount ?? payload.totalAmount) || 'बताई गई रकम',
    product_name:     speakableProduct(payload.product_name || '', 'hi-IN') || payload.product_name || 'आपका सामान',
    delivery_city:    payload.delivery_city || '',
    delivery_area:    payload.delivery_area || '',
    store_name:       brandName,
    store_category:   brandCategory,
  };

  // Only send defined/non-empty dynamic variables so the prompt doesn't see
  // literal "undefined" or empty braces.
  const vars = Object.fromEntries(
    Object.entries(dynamicVariables).filter(([, v]) => v !== undefined && v !== '')
  );

  const fromNumber = process.env.VOBIZ_FROM_NUMBER || '+917971542878';
  const webhookUrl = `${RETELL_WEBHOOK_BASE}/webhook/retell/call-event`.replace(/([^:])\/\//g, '$1/');

  const body = {
    from_number: fromNumber,
    to_number: phone,
    agent_id: RETELL_AGENT_ID,
    retell_llm_dynamic_variables: vars,
    webhook_url: webhookUrl,
    metadata: {
      profile,
      shop: identity.shop || payload.shop || '',
      order_id: identity.entityRef || payload.order_id || payload.orderId || '',
      order_name: identity.entityName || payload.order_name || payload.orderName || '',
    },
  };

  let json;
  try {
    json = await retell().call.createPhoneCall(body);
  } catch (err) {
    // Retell.APIError exposes .status + a parsed message; fall back to err.message.
    const msg = err?.error?.message || err?.message || String(err);
    throw new Error(`Retell create-phone-call failed: ${msg}`);
  }

  const callId = json.call_id;
  console.log(`[trigger-retell] call=${callId} → ${phone} (agent=${RETELL_AGENT_ID})`);

  return {
    ok: true,
    room_name: callId,
    sip: { sipCallId: callId },
    egress_id: null,
    retell_call_id: callId,
  };
}
