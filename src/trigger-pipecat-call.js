/**
 * Trigger an outbound COD-confirm call via Pipecat + Vobiz.
 *
 * The scheduler's dispatchOne() calls this when COD_CONFIRM_RUNTIME=pipecat.
 * It POSTs the order context to the local cod-pipecat service (/start), which
 * places the Vobiz call (DLT +91 caller ID) and streams 8kHz mulaw media into
 * the Pipecat pipeline (Sarvam STT -> Bedrock LLM -> Sarvam TTS).
 *
 * Returns the same { ok, room_name, sip } shape as triggerRetellCall /
 * triggerLivekitCall / triggerRelayCall so the scheduler's post-placement
 * bookkeeping (CallAttempt, outcome correlation) is unchanged.
 */

// Speak the REAL product name, lightly cleaned: strip marketing filler +
// packaging suffixes, keep brand + type, cap length so it stays speakable and
// never reads a 10-word SKU aloud. (Was speakableProduct, which collapsed every
// eyewear title to a generic "chashme" and lost the brand.)
const _PRODUCT_FILLER = [
  /\bwith original (box )?packing\b/gi,
  /\boriginal (box )?packing\b/gi,
  /\blimited edition\b/gi,
  /\bkaran aujla edition\b/gi,
  /\b(brand )?new\b/gi,
  /\(x\s*\d+\)/gi,
];
function cleanProductName(title) {
  if (!title) return '';
  let t = String(title);
  for (const re of _PRODUCT_FILLER) t = t.replace(re, ' ');
  t = t.replace(/\s+/g, ' ').trim();
  const words = t.split(' ').filter(Boolean);
  return words.slice(0, 6).join(' ');
}
// Strip trailing/standalone punctuation from a person name ("Ravi ." -> "Ravi").
function cleanName(name) {
  if (!name) return '';
  return String(name).replace(/\s*[._,\-]+\s*$/g, '').replace(/\s+/g, ' ').trim();
}

const PIPECAT_BASE = process.env.COD_PIPECAT_URL || 'http://127.0.0.1:3106';
const TOOL_SECRET = process.env.LIVEKIT_TOOL_SECRET || '';
const VOBIZ_FROM = process.env.VOBIZ_FROM_NUMBER || '';

export async function triggerPipecatCall({ phone, profile = 'cod-confirm', payload = {}, identity = {}, branding = {} }) {
  if (!phone) throw new Error('phone required (E.164)');
  if (!TOOL_SECRET) throw new Error('LIVEKIT_TOOL_SECRET not set');

  // Sarvam TTS speaks Hindi/numbers natively, so (unlike the Retell path) we do
  // NOT pre-format amounts to Devanagari — we only collapse the long Shopify SKU
  // to a short spoken product noun. The bot builds the Hinglish prompt.
  const body = {
    customer_name: cleanName(payload.customer_name),
    order_number:  payload.order_number || identity.entityRef || '',
    product_name:  cleanProductName(payload.product_name),
    total_amount:  payload.total_amount != null ? String(payload.total_amount) : '',
    delivery_city: payload.delivery_city || '',
    delivery_area: payload.delivery_area || '',
    store_name:    payload.store_name || branding.name || '',
    store_category: payload.store_category || branding.category || '',
    shop:          identity.shop || '',
    entity_ref:    identity.entityRef || '',
    opening_line:  payload.opening_line || '',
  };

  const res = await fetch(`${PIPECAT_BASE}/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-COD-Tool-Secret': TOOL_SECRET },
    body: JSON.stringify({ phone_number: phone, from_number: VOBIZ_FROM, body }),
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`cod-pipecat /start ${res.status}: ${txt.slice(0, 200)}`);
  let data = {};
  try { data = JSON.parse(txt); } catch { /* non-JSON */ }
  const callUuid = data.call_uuid || 'unknown';
  console.log(`[trigger-pipecat] call=${callUuid} -> ${phone} (Pipecat/Vobiz)`);
  return { ok: true, room_name: callUuid, sip: { sipCallId: callUuid }, egress_id: null };
}
