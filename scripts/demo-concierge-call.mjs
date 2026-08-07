// Quick DEMO: place a natural, human-feeling concierge call (US/Canada, +1, via
// Twilio) — defaults to the "Ria" persona. Bypasses the scheduler/DND and dials
// immediately via triggerLivekitCall, so it works any time of day.
//
// Usage:
//   node scripts/demo-concierge-call.mjs +1XXXXXXXXXX            # call Ria
//   node scripts/demo-concierge-call.mjs +1XXXXXXXXXX "Friend"   # override name
//
// Requires: cod-confirm-agent.service running (the LiveKit worker that answers).

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_DIR = join(__dirname, '..');
const ENV_PATH = join(APP_DIR, '..', '..', '.env'); // repo-root .env

// --- load .env into process.env BEFORE importing the call module ---
for (const raw of readFileSync(ENV_PATH, 'utf8').split('\n')) {
  const line = raw.trim();
  if (!line || line.startsWith('#')) continue;
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (!m) continue;
  let val = m[2];
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    val = val.slice(1, -1);
  }
  if (process.env[m[1]] === undefined) process.env[m[1]] = val;
}

const phone = process.argv[2];
const name = process.argv[3] || 'Ria';
if (!phone || !/^\+\d{8,15}$/.test(phone)) {
  console.error('Usage: node scripts/demo-concierge-call.mjs +1XXXXXXXXXX ["Name"]');
  console.error('  (phone must be E.164, e.g. +14165551234 for Toronto)');
  process.exit(1);
}

// --- the natural-conversation persona ---
const agentName = 'Maya';
const payload = {
  agent_name: agentName,
  brand_name: 'Mesh Pilot',
  customer_name: name,
  opening_line: `Hey ${name}! It's ${agentName}. Hope I'm not catching you at a bad time — do you have a quick minute to chat?`,
  goal:
    `Have a warm, natural, casual catch-up with ${name} — like a friendly assistant checking in. ` +
    `Ask how she's been, how her dog Buddy is doing, how things are going at the bank, and how she's ` +
    `liking Toronto these days. React genuinely to what she says, ask easy follow-up questions, keep it ` +
    `light and human, and wrap up warmly after a minute or two. This is a friendly demo of how natural ` +
    `the voice agent sounds — be charming and conversational, never salesy, never robotic. When the chat ` +
    `naturally winds down, say a warm goodbye and call complete_call.`,
  context:
    `${name} is a good friend. She has a dog named Buddy. She works at a bank. She lives in Toronto, Canada. ` +
    `If she asks who you are or whether you're an AI, be honest and friendly: you are Mesh Pilot's AI voice ` +
    `assistant doing a quick friendly demo for her. Do not pretend to be a human if asked directly, but ` +
    `otherwise just keep the conversation natural.`,
};

const { triggerLivekitCall } = await import(join(APP_DIR, 'src', 'trigger-livekit-call.js'));

console.log(`\n📞 Dialing ${name} at ${phone} (concierge / en-US / Twilio)…`);
try {
  const res = await triggerLivekitCall({
    phone,
    profile: 'concierge',
    lang: 'en-US',
    payload,
    identity: { shop: '_demo', entityRef: `demo-${Date.now()}`, entityName: `${name} (demo)` },
    branding: { name: 'Mesh Pilot', category: '' },
  });
  console.log(`✅ Call placed. room=${res.room_name}  sip=${res?.sip?.sipCallId || '-'}`);
  console.log(`   ${agentName} will open with: "${payload.opening_line}"`);
  console.log('   (the agent is on the line now — pick up!)\n');
} catch (err) {
  console.error('❌ Call failed:', err?.message || err);
  process.exit(1);
}
process.exit(0);
