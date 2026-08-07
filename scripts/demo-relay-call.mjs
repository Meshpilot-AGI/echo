// DEMO: place an outbound call via Twilio ConversationRelay (no LiveKit).
// Twilio does telephony + ASR + ElevenLabs TTS; our relay server (:3105, exposed
// at wss://shopify.meshpilot.app/relay/ws) runs the concierge LLM brain.
//
//   node scripts/demo-relay-call.mjs +1XXXXXXXXXX ["Name"]
//
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Twilio from 'twilio';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV = join(__dirname, '..', '..', '..', '.env');
for (const raw of readFileSync(ENV, 'utf8').split('\n')) {
  const m = raw.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (!m || raw.trim().startsWith('#')) continue;
  let v = m[2]; if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  if (process.env[m[1]] === undefined) process.env[m[1]] = v;
}

const phone = process.argv[2];
const name = process.argv[3] || 'Ria';
if (!phone || !/^\+\d{8,15}$/.test(phone)) { console.error('Usage: node scripts/demo-relay-call.mjs +1XXXXXXXXXX ["Name"]'); process.exit(1); }

const t = Twilio(process.env.TWILIO_API_KEY_SID, process.env.TWILIO_API_KEY_SECRET, { accountSid: process.env.TWILIO_ACCOUNT_SID });
const FROM = process.env.TWILIO_FROM_NUMBER;
const WSS = process.env.RELAY_WSS_URL || 'wss://shopify.meshpilot.app/relay/ws';
const VOICE = process.env.ELEVENLABS_VOICE_ID_INTL || process.env.ELEVENLABS_VOICE_ID; // ElevenLabs voice ID

const agentName = 'Maya';
const goal = `Have a warm, natural, casual catch-up with ${name} — ask how she's been, how her dog Buddy is doing, how things are at the bank, and how she's liking Toronto. React genuinely, keep it light and human, wrap up warmly after a minute or two. This is a friendly demo of how natural the agent sounds — never salesy or robotic.`;
const context = `${name} is a good friend. She has a dog named Buddy. She works at a bank. She lives in Toronto, Canada. If asked whether you're an AI, be honest: you're Mesh Pilot's AI voice assistant doing a quick friendly demo.`;
const greeting = `Hey ${name}! It's ${agentName}. Hope I'm not catching you at a bad time — do you have a quick minute to chat?`;

// Build TwiML: <Connect><ConversationRelay ttsProvider=ElevenLabs voice=...><Parameter .../></ConversationRelay></Connect>
const resp = new Twilio.twiml.VoiceResponse();
// Record the call (ConversationRelay ignores REST record:true — must use TwiML).
resp.start().recording({ recordingChannels: 'dual' });
const connect = resp.connect();
const cr = connect.conversationRelay({
  url: WSS,
  ttsProvider: 'ElevenLabs',
  voice: VOICE,
  transcriptionProvider: 'Deepgram',
  speechModel: 'nova-2-phonecall',
  welcomeGreeting: greeting,
  interruptible: 'speech',
});
cr.parameter({ name: 'agent_name', value: agentName });
cr.parameter({ name: 'brand_name', value: 'Mesh Pilot' });
cr.parameter({ name: 'customer_name', value: name });
cr.parameter({ name: 'goal', value: goal });
cr.parameter({ name: 'context', value: context });
// Persistence keys (relay server writes CallTurn rows + marks outcome by these)
cr.parameter({ name: 'shop', value: '_demo' });
cr.parameter({ name: 'entity_ref', value: `relay-demo-${Date.now()}` });
const twiml = resp.toString();

console.log(`\n📞 ConversationRelay call → ${name} ${phone}  (ElevenLabs voice=${VOICE})`);
console.log(`   WSS: ${WSS}`);
try {
  const call = await t.calls.create({ to: phone, from: FROM, twiml });
  console.log(`✅ Placed. callSid=${call.sid} status=${call.status}`);
  // poll status a few times
  for (let i = 0; i < 6; i++) {
    await new Promise(r => setTimeout(r, 4000));
    const c = await t.calls(call.sid).fetch();
    console.log(`   [${(i + 1) * 4}s] status=${c.status}${c.duration ? ' dur=' + c.duration + 's' : ''}`);
    if (['completed', 'failed', 'busy', 'no-answer', 'canceled'].includes(c.status)) break;
  }
} catch (err) {
  console.error('❌ Call failed:', err?.message || err, err?.code ? `(code ${err.code})` : '');
}
process.exit(0);
