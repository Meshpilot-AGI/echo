/**
 * One-time setup: create a Retell Agent powered by a Conversation Flow.
 *
 * NOTE (2026-06-09): FIRST-TIME bootstrap only. Ongoing agent config changes go
 * through the SDK config-as-code pair: retell/agent.config.json ←→
 * src/retell-{capture,apply}-config.mjs. The live agent is canonical.
 *
 * Requires RETELL_CONVERSATION_FLOW_ID (from setup-retell-conversation-flow.mjs).
 *
 * Run:
 *   RETELL_API_KEY=... RETELL_CONVERSATION_FLOW_ID=... \
 *     node src/setup-retell-conversation-flow-agent.mjs
 *
 * Prints agent_id — copy into .env as RETELL_AGENT_ID.
 */

const RETELL_API_KEY = process.env.RETELL_API_KEY;
const CONVERSATION_FLOW_ID = process.env.RETELL_CONVERSATION_FLOW_ID;
const SERVER_URL = process.env.SERVER_URL || process.env.COD_CONFIRM_WEBHOOK_BASE || 'https://shopify.meshpilot.app/cod-confirm';
const STORE_NAME = process.env.STORE_NAME || 'our store';

if (!RETELL_API_KEY || !CONVERSATION_FLOW_ID) {
  console.error('Missing RETELL_API_KEY or RETELL_CONVERSATION_FLOW_ID');
  process.exit(1);
}

async function r(path, body, method = 'POST') {
  const res = await fetch(`https://api.retellai.com${path}`, {
    method,
    headers: { Authorization: `Bearer ${RETELL_API_KEY}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) {
    console.error(`${method} ${path} failed ${res.status}:`, JSON.stringify(json, null, 2).slice(0, 2000));
    process.exit(1);
  }
  return json;
}

// Pronunciation guidance for common Hindi words + store name.
// Using approximate IPA for Indian pronunciation.
function buildPronunciationDictionary() {
  const dict = [
    { word: 'Priya', alphabet: 'ipa', phoneme: 'ˈpɾijaː' },
    { word: 'Namaste', alphabet: 'ipa', phoneme: 'nəməsteː' },
    { word: 'Dhanyawaad', alphabet: 'ipa', phoneme: 'd̪ʱənjəʋaːd̪' },
    { word: 'bilkul', alphabet: 'ipa', phoneme: 'bɪlkʊl' },
    { word: 'achha', alphabet: 'ipa', phoneme: 'ətʃʰaː' },
    { word: 'haan', alphabet: 'ipa', phoneme: 'ɦaːn' },
    { word: 'ji', alphabet: 'ipa', phoneme: 'dʒiː' },
  ];
  if (STORE_NAME && STORE_NAME !== 'our store') {
    dict.push({ word: STORE_NAME, alphabet: 'ipa', phoneme: guessIpaForStoreName(STORE_NAME) });
  }
  return dict;
}

function guessIpaForStoreName(name) {
  // Very rough heuristic: common English brand names keep their English pronunciation.
  // For truly Indian names, add manual entries later.
  const lower = name.toLowerCase();
  if (lower.includes('urban')) return 'ˈɜːrbən';
  if (lower.includes('classics')) return 'ˈklæsɪks';
  if (lower.includes('storico')) return 'ˈstɔːrɪkoʊ';
  if (lower.includes('classicoo')) return 'kləˈsiːkuː';
  if (lower.includes('trendsetters')) return 'ˈtɾɛndˌsɛtəz';
  return name;
}

async function main() {
  console.log('Creating Retell Conversation-Flow Agent...');
  const agent = await r('/create-agent', {
    agent_name: `COD Confirm — ${STORE_NAME} (Priya — Conversation Flow)`,
    // voice_id: the live agent uses a custom ElevenLabs library voice added via
    // the Retell dashboard (custom_voice_…); 11labs-Monika is the bootstrap default.
    voice_id: '11labs-Monika',
    // eleven_multilingual_v2 = best HINDI prosody/quality (29 langs) — matches what
    // ElevenLabs' own UI uses; turbo/flash are speed-optimized and weaker on Hindi.
    // eleven_v3 (expressive) drops/clips words on the SIP stream — avoid it.
    voice_model: 'eleven_multilingual_v2',
    // Lower temperature = more stable/consistent generation (a pitch should be
    // consistent, not highly variant). 1.15 was too high → instability/word drops.
    voice_temperature: 0.8,
    voice_speed: 0.92,
    enable_dynamic_voice_speed: true,
    enable_dynamic_responsiveness: true,
    responsiveness: 0.85,
    volume: 1,
    // 0.4 (was 0.6): agent finishes its pitch without being cut off by the
    // customer's backchannel ("haan haan") / background noise; still interruptible.
    interruption_sensitivity: 0.4,
    enable_backchannel: true,
    backchannel_frequency: 0.5,
    backchannel_words: ['haan', 'hmm', 'achha', 'ji'],
    normalize_for_speech: true,
    boosted_keywords: [STORE_NAME, 'Priya', 'COD', 'Hinglish', 'Namaste', 'Dhanyawaad', 'Urban', 'Classics'],
    ambient_sound: null,
    language: ['hi-IN', 'en-IN'],
    stt_mode: 'accurate',
    denoising_mode: 'noise-and-background-speech-cancellation',
    response_engine: {
      type: 'conversation-flow',
      conversation_flow_id: CONVERSATION_FLOW_ID,
    },
    webhook_url: `${SERVER_URL}/webhook/retell/call-event`,
    webhook_events: ['call_started', 'call_ended', 'call_analyzed'],
    max_call_duration_ms: 3 * 60 * 1000,
    end_call_after_silence_ms: 15000,
    voicemail_option: { action: { type: 'hangup' } },
    pronunciation_dictionary: buildPronunciationDictionary(),
    handbook_config: {
      natural_filler_words: true,
      high_empathy: true,
      speech_normalization: true,
      smart_matching: true,
      ai_disclosure: false,
      scope_boundaries: true,
      default_personality: false,
      echo_verification: false,
      nato_phonetic_alphabet: false,
    },
    post_call_analysis_data: [
      { type: 'system-presets', name: 'call_summary' },
      { type: 'system-presets', name: 'call_successful' },
      { type: 'system-presets', name: 'user_sentiment' },
    ],
    analysis_successful_prompt:
      'The agent finished the COD confirmation task. The call is successful if the customer confirmed, cancelled, requested a callback, or was transferred to a human agent.',
  });

  console.log('\n=====');
  console.log('RETELL_AGENT_ID=' + agent.agent_id);
  console.log('ConversationFlow=' + CONVERSATION_FLOW_ID);
  console.log('=====');
  console.log('\nPaste RETELL_AGENT_ID into .env and restart the server.');
}

main().catch(err => { console.error(err); process.exit(1); });
