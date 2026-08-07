/**
 * Dispatch an outbound international call via Twilio ConversationRelay, and
 * build the shared ConversationRelay TwiML (reused by inbound /voice/incoming).
 *
 * The scheduler's dispatchOne() calls triggerRelayCall for the `concierge`
 * profile (US/+1) instead of triggerLivekitCall — Twilio owns telephony + ASR +
 * ElevenLabs TTS, and our relay server (src/relay-server.js, wss://…/relay/ws)
 * runs the LLM brain. Returns the same { ok, room_name, sip } shape
 * triggerLivekitCall does so the scheduler's post-placement bookkeeping is
 * unchanged. The relay server correlates back via the shop/entity_ref params.
 */
import Twilio from 'twilio';

const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const API_KEY_SID = process.env.TWILIO_API_KEY_SID || process.env.TWILIO_ACCOUNT_SID;
const API_KEY_SECRET = process.env.TWILIO_API_KEY_SECRET || process.env.TWILIO_AUTH_TOKEN;
const FROM_NUMBER = process.env.TWILIO_FROM_NUMBER;
const RELAY_WSS = process.env.RELAY_WSS_URL || 'wss://shopify.meshpilot.app/relay/ws';
const EL_VOICE = process.env.ELEVENLABS_VOICE_ID_INTL || process.env.ELEVENLABS_VOICE_ID;

let _client = null;
function client() {
  if (!_client) {
    if (!ACCOUNT_SID || !API_KEY_SID || !API_KEY_SECRET) {
      throw new Error('Twilio creds missing (TWILIO_ACCOUNT_SID / API_KEY_SID / API_KEY_SECRET)');
    }
    _client = Twilio(API_KEY_SID, API_KEY_SECRET, { accountSid: ACCOUNT_SID });
  }
  return _client;
}

/**
 * Build the <Connect><ConversationRelay> TwiML for a call. Shared by the
 * outbound dispatcher (triggerRelayCall) and the inbound webhook route so both
 * sides talk to the same relay brain with the same voice/ASR config.
 */
export function buildRelayTwiml({ payload = {}, identity = {}, branding = {} } = {}) {
  if (!EL_VOICE) throw new Error('ELEVENLABS_VOICE_ID(_INTL) not set');

  const agentName = payload.agent_name || process.env.CONCIERGE_AGENT_NAME || 'Alex';
  const brandName = payload.brand_name || branding.name || process.env.STORE_NAME || 'our team';
  const customer = payload.customer_name || '';
  const greeting = payload.opening_line
    || `Hi${customer ? ' ' + customer : ''}, this is ${agentName} from ${brandName}. Do you have a quick minute?`;

  const resp = new Twilio.twiml.VoiceResponse();
  // Record the call. ConversationRelay ignores REST `record:true`, so recording
  // MUST be started in TwiML via <Start><Recording> BEFORE <Connect>. The
  // <Start><Recording> noun records a single (mixed) track — `recordingChannels`
  // is NOT a valid attribute here (it triggers Twilio warning 12200 and is
  // dropped), so we omit it. Twilio stores the recording; fetch by callSid or
  // via the optional RELAY_RECORDING_STATUS_CALLBACK.
  if ((process.env.RELAY_RECORDING || 'on').toLowerCase() !== 'off') {
    const recOpts = {};
    const cb = process.env.RELAY_RECORDING_STATUS_CALLBACK;
    if (cb) { recOpts.recordingStatusCallback = cb; recOpts.recordingStatusCallbackEvent = 'completed'; }
    resp.start().recording(recOpts);
  }
  const connect = resp.connect();
  const cr = connect.conversationRelay({
    url: RELAY_WSS,
    ttsProvider: 'ElevenLabs',
    voice: EL_VOICE,
    transcriptionProvider: 'Deepgram',
    speechModel: 'nova-2-phonecall',
    welcomeGreeting: greeting,
    interruptible: 'speech',
  });
  const params = {
    agent_name: agentName,
    brand_name: brandName,
    customer_name: customer,
    goal: payload.goal || 'have a brief, friendly check-in',
    context: payload.context || '',
    // correlation keys → relay persists CallTurn + marks outcome by these
    shop: identity.shop || '_concierge_intl',
    entity_ref: identity.entityRef || '',
  };
  for (const [name, value] of Object.entries(params)) {
    if (value != null && value !== '') cr.parameter({ name, value: String(value) });
  }
  return resp.toString();
}

export async function triggerRelayCall({ phone, payload = {}, identity = {}, branding = {} }) {
  if (!phone) throw new Error('phone required (E.164)');
  if (!FROM_NUMBER) throw new Error('TWILIO_FROM_NUMBER not set');

  const twiml = buildRelayTwiml({ payload, identity, branding });
  const call = await client().calls.create({ to: phone, from: FROM_NUMBER, twiml });
  console.log(`[trigger-relay] call=${call.sid} → ${phone} (ConversationRelay/ElevenLabs)`);
  // Mirror triggerLivekitCall's return shape: roomName/sipCallId = the Twilio callSid.
  return { ok: true, room_name: call.sid, sip: { sipCallId: call.sid }, egress_id: null };
}
