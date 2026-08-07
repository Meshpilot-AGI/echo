/**
 * Glitch Voice — generic LiveKit voice agent worker (engine).
 *
 * Long-running worker process. Registers with LiveKit Cloud, subscribes to
 * dispatch requests, and handles each inbound call with a profile-driven
 * agent. The engine itself is profile-agnostic: STT/TTS/LLM construction,
 * SIP audio handling, VAD, AEC, turn-detection, voicemail detection,
 * auto-hangup, and transcript persistence live here. The agent's
 * personality, prompt, tools, and welcome message are imported from the
 * per-call profile's `agent.js` module (e.g. profiles/cod-confirm/agent.js).
 *
 * The profile id arrives as a LiveKit participant attribute (`profile`)
 * set by trigger-livekit-call.js. Falls back to `cod-confirm` for legacy
 * dispatches that pre-date the multi-profile rollout.
 *
 * Architecture + idioms follow @livekit/agents v1.2.x Node.js patterns.
 * Upstream: https://github.com/livekit/agents-js — @livekit/agents@1.2.6.
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  cli,
  defineAgent,
  ServerOptions,
  voice,
} from '@livekit/agents';
import * as silero from '@livekit/agents-plugin-silero';
import * as livekit from '@livekit/agents-plugin-livekit';
import * as sarvam from '@livekit/agents-plugin-sarvam';
import * as elevenlabs from '@livekit/agents-plugin-elevenlabs';
import * as openai from '@livekit/agents-plugin-openai';
import { TelephonyBackgroundVoiceCancellation } from '@livekit/noise-cancellation-node';
import { RoomServiceClient } from 'livekit-server-sdk';
import { getProfile } from './lib/profiles.js';

const WEBHOOK_BASE = process.env.COD_CONFIRM_WEBHOOK_BASE
  || 'https://your-domain.com/cod-confirm';
const TOOL_SECRET = process.env.LIVEKIT_TOOL_SECRET || '';
const DEFAULT_PROFILE_ID = process.env.DEFAULT_AGENT_PROFILE || 'cod-confirm';

// ── OpenAI for the VOICE path (LLM + en-IN STT) ──────────────────────────
// The rest of the stack points OPENAI_API_KEY / OPENAI_BASE_URL at the Vercel
// AI Gateway (key prefix `vck_`, base ai-gateway.vercel.sh). The gateway
// proxies chat completions but exposes NO speech-to-text model, so routing the
// agent's `gpt-4o-transcribe` STT through it silently breaks en-IN calls
// (customer audio never transcribes → agent has nothing to answer). Pin the
// voice agent to a DIRECT OpenAI key + endpoint instead. Prefer the dedicated
// OPENAI_API_KEY_VOICE; fall back to OPENAI_API_KEY only if it's a real `sk-`
// key (never a `vck_` gateway key).
const OPENAI_VOICE_KEY = (() => {
  const dedicated = process.env.OPENAI_API_KEY_VOICE;
  if (dedicated) return dedicated;
  const shared = process.env.OPENAI_API_KEY || '';
  return shared.startsWith('sk-') ? shared : '';
})();
const OPENAI_VOICE_BASE_URL = process.env.OPENAI_API_BASE_VOICE || 'https://api.openai.com/v1';
if (!OPENAI_VOICE_KEY) {
  console.warn('[openai] no direct voice key — set OPENAI_API_KEY_VOICE (sk-...). LLM + en-IN STT will fail.');
} else {
  console.log(`[openai] voice path → ${OPENAI_VOICE_BASE_URL} key=${OPENAI_VOICE_KEY.slice(0, 7)}…`);
}

// STT provider factory. Sarvam Saaras v3 is best-in-class for Hindi /
// Hinglish but is hi-IN-only — it transliterates pure-English audio into
// Devanagari nonsense (real test call to a +1 number: customer said
// "hello", STT produced "हेलो"-like garbage and the LLM had nothing
// transcribable to respond to).
//
// For en-IN we use OpenAI's Whisper-based STT (gpt-4o-transcribe — the
// successor to whisper-1 — handles Indian-accented English and code-mix
// well enough for our domain). OpenAI plugin is already a dependency for
// the LLM, so no new install.
function buildSTT(lang) {
  // Hindi → Sarvam Saaras v3 (best-in-class hi/Hinglish). Every other language
  // (en-IN Indian-English, en-US international, …) → OpenAI English transcribe.
  if (lang === 'hi-IN') {
    // HI_STT=elevenlabs → ElevenLabs Scribe v2 Realtime (streaming WebSocket STT,
    // ~150ms, 90+ langs incl. Hindi, server-side VAD). Moves the India path to
    // ElevenLabs end-to-end (STT+TTS) and eliminates the Sarvam STT websocket
    // drops that caused 8–20s mid-call gaps (different vendor, different socket).
    // Sarvam Saaras v3 (best-in-class Hinglish) stays the default + instant
    // fallback — flip HI_STT back to sarvam if Scribe's code-mix quality regresses.
    if ((process.env.HI_STT || 'sarvam').toLowerCase() === 'elevenlabs') {
      console.log('[stt] provider=elevenlabs model=scribe_v2_realtime lang=hi-IN (8kHz, serverVad)');
      return new elevenlabs.STT({
        modelId: 'scribe_v2_realtime',
        languageCode: 'hi',
        sampleRate: 8000,
        serverVad: {
          minSilenceDurationMs: parseInt(process.env.EL_VAD_SILENCE_MS || '500', 10),
        },
      });
    }
    console.log(`[stt] provider=sarvam model=saaras:v3 lang=${lang}`);
    return new sarvam.STT({
      model: 'saaras:v3',
      languageCode: 'hi-IN',
    });
  }
  // International (en-US) agent: ElevenLabs Scribe STT — pairs with ElevenLabs
  // TTS so the whole international voice path is one vendor. Toggle to OpenAI
  // via INTL_STT=openai. (en-IN cod-confirm English stays on OpenAI below.)
  if (lang === 'en-US' && (process.env.INTL_STT || 'elevenlabs').toLowerCase() === 'elevenlabs') {
    console.log('[stt] provider=elevenlabs model=scribe_v2_realtime lang=en-US (8kHz, serverVad)');
    return new elevenlabs.STT({
      modelId: 'scribe_v2_realtime',
      languageCode: 'en',
      sampleRate: 8000,
      serverVad: { minSilenceDurationMs: parseInt(process.env.EL_VAD_SILENCE_MS || '500', 10) },
    });
  }
  console.log(`[stt] provider=openai model=gpt-4o-transcribe lang=${lang}`);
  return new openai.STT({
    model: 'gpt-4o-transcribe',
    language: 'en',
    detectLanguage: false,
    apiKey: OPENAI_VOICE_KEY,
    baseURL: OPENAI_VOICE_BASE_URL,
  });
}

// TTS provider factory. ElevenLabs is the sole TTS engine (Sarvam Bulbul TTS
// retired 2026-06-04 — ElevenLabs is the chosen voice). Sarvam is NOT gone from
// the stack: it remains the Hindi STT engine in buildSTT(). Per-profile voice
// tuning (voiceId, model) will move into profile.json in a later phase; for
// now, env vars stay the lever.
function buildTTS(lang) {
  const isHindi = lang === 'hi-IN';
  // Non-Hindi (international) calls prefer a dedicated voice if configured
  // (ELEVENLABS_VOICE_ID_INTL, e.g. a US-English voice), else the default.
  const voiceId = (!isHindi && process.env.ELEVENLABS_VOICE_ID_INTL) || process.env.ELEVENLABS_VOICE_ID;
  if (!voiceId) {
    throw new Error('ELEVENLABS_VOICE_ID is not set — required for TTS');
  }
  // ElevenLabs wants an ISO-639-1 code. Keep hi-IN exactly as-is (unchanged
  // live behaviour); everything else → 'en'.
  const elLang = isHindi ? lang : 'en';
  // Telephony codec. hi-IN/Vobiz works on linear pcm_8000 (leave it). For the
  // international/Twilio leg, linear PCM played back too fast (sample-rate
  // mismatch on the SRTP/PSTN bridge); μ-law 8kHz (ulaw_8000) is the native
  // PSTN/PCMU format and renders at correct speed. Override per side via
  // ELEVENLABS_INTL_ENCODING.
  // ulaw_8000 distorted on the LiveKit pipeline (it expects linear PCM); keep
  // pcm_8000. The international voice agent is moving to Twilio ConversationRelay
  // (native telephony + ASR + ElevenLabs TTS) where this codec dance goes away.
  const encoding = isHindi ? 'pcm_8000' : (process.env.ELEVENLABS_INTL_ENCODING || 'pcm_8000');
  // Optional pace control (1.0 = normal). flash can sound rushed; set
  // ELEVENLABS_INTL_SPEED=0.9 to slow the international voice slightly.
  const speedRaw = !isHindi && process.env.ELEVENLABS_INTL_SPEED ? parseFloat(process.env.ELEVENLABS_INTL_SPEED) : null;
  console.log(`[tts] provider=elevenlabs voice=${voiceId} lang=${lang} el=${elLang} enc=${encoding}${speedRaw ? ' speed=' + speedRaw : ''}`);
  return new elevenlabs.TTS({
    voiceId,
    // flash_v2_5 = ElevenLabs' ultra-low-latency conversational model (32 langs
    // incl. Hindi) — chosen over turbo_v2_5 to cut TTS first-byte latency on
    // telephony. Override via ELEVENLABS_MODEL (e.g. eleven_turbo_v2_5 for a
    // touch more quality at higher latency).
    model: process.env.ELEVENLABS_MODEL || 'eleven_flash_v2_5',
    language: elLang,
    encoding,
    ...(speedRaw ? { speed: speedRaw } : {}),
  });
}

// Profile-module cache: import once per (profileId, worker process).
const profileModuleCache = new Map();
async function loadProfileModule(profileId) {
  if (profileModuleCache.has(profileId)) return profileModuleCache.get(profileId);
  const profile = getProfile(profileId);
  if (!profile) {
    throw new Error(`[profile] unknown profile "${profileId}" — check profiles/<id>/profile.json`);
  }
  const agentPath = `${profile._dir}/agent.js`;
  const mod = await import(pathToFileURL(agentPath).href);
  for (const fn of ['renderContext', 'buildSystemPrompt', 'buildWelcome', 'buildTools', 'turnPersistKey']) {
    if (typeof mod[fn] !== 'function') {
      throw new Error(`[profile] ${agentPath} is missing required export "${fn}"`);
    }
  }
  if (!(mod.TERMINAL_TOOLS instanceof Set)) {
    throw new Error(`[profile] ${agentPath} must export TERMINAL_TOOLS as a Set<string>`);
  }
  console.log(`[profile] loaded "${profileId}" from ${agentPath} (tools: ${[...mod.TERMINAL_TOOLS].join(', ')})`);
  const cached = { profile, ...mod };
  profileModuleCache.set(profileId, cached);
  return cached;
}

// Voicemail detection — engine-level, applies to every profile. Real call
// #2953 (Storico) burned 2 minutes pitching to a voicemail recording before
// we added this. Patterns are broad: partial match anywhere in any of the
// first 4 user transcripts triggers an immediate hangup.
const VOICEMAIL_PATTERNS = [
  /व[ोॉ]इस[\s\-]*मे/,
  /फ[ॉो]रवर्डेड\s+टू/,
  /न[ॉो]ट\s+अव[ेै]लेबल/,
  /रिक[ॉो]र्ड\s+य[ोौ]र\s+म[ैे]सेज/,
  /लीव\s+अ\s+म[ैे]सेज/,
  /एट\s+द\s+ट[ोौ]न/,
  /आफ्टर\s+द\s+बीप/,
  /व्हेन\s+य[ोौ]\s+ह[ैै]व\s+फिनिश्ड/,
  /इस\s+समय\s+उपलब्ध\s+नहीं/,
  /कृपया\s+संदेश\s+छोड़/,
  /voicemail|voice\s*mail/i,
  /answering\s*machine/i,
  /please\s+(record|leave)\s+(your\s+)?(message|name)/i,
  /(after|at)\s+the\s+(tone|beep)/i,
];

export default defineAgent({
  prewarm: async (proc) => {
    proc.userData.vad = await silero.VAD.load({
      sampleRate: 8000,
      minSilenceDuration: 400,
      // Noise hardening: require speech to be louder/more-confident
      // (activationThreshold) and sustained (minSpeechDuration) before it
      // counts as a turn — rejects brief background blips, a cough, or a TV
      // murmur. NOTE: this does NOT stop a loud, continuous background VOICE
      // (e.g. family chatter) from reaching STT — that needs Krisp background-
      // voice-cancellation on the input track (see ENGINEERING_SUPERVISOR).
      activationThreshold: parseFloat(process.env.VAD_ACTIVATION_THRESHOLD || '0.6'),
      minSpeechDuration: parseInt(process.env.VAD_MIN_SPEECH_MS || '100', 10),
    });
    const warmupHosts = [
      'https://api.sarvam.ai/',
      'https://api.elevenlabs.io/v1/models',
      'https://api.openai.com/v1/models',
    ];
    await Promise.all(warmupHosts.map(async (url) => {
      try {
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), 4000);
        await fetch(url, { method: 'HEAD', signal: controller.signal }).catch(() => {});
        clearTimeout(t);
      } catch { /* best-effort */ }
    }));
    console.log('[prewarm] TLS/DNS warmed for Sarvam + ElevenLabs + OpenAI');
  },

  entry: async (ctx) => {
    await ctx.connect();

    // Dispatch metadata is set by trigger-livekit-call.js (createDispatch
    // metadata field) and includes the call's language hint. Reading it
    // BEFORE the AgentSession is constructed lets us pick the right STT
    // provider (Sarvam for Hindi, OpenAI for English) without a mid-call
    // STT swap. Falls back to hi-IN if metadata is missing or unparseable
    // (the production-default and 98% of cod-confirm traffic).
    let dispatchMeta = {};
    try {
      const raw = ctx.job?.metadata || ctx.room?.metadata || '';
      if (raw && typeof raw === 'string' && raw.trim().startsWith('{')) {
        dispatchMeta = JSON.parse(raw);
      }
    } catch (err) {
      console.warn('[dispatch-meta] could not parse:', err.message);
    }
    const initialLang = dispatchMeta.lang || 'hi-IN';
    console.log(`[entry] dispatch lang=${initialLang} profile=${dispatchMeta.profile || '?'}`);

    const ctxMut = {
      v: {},
      lang: initialLang,
      turnIndex: 0,
      sipCallId: null,
      profileId: DEFAULT_PROFILE_ID,
      profileMod: null,
    };
    const roomName = ctx.room?.name || '';

    async function postTurn({ role, text, tool_name, tool_args, tool_result, stt_confidence }) {
      if (!ctxMut.profileMod || !roomName) return;
      const key = ctxMut.profileMod.turnPersistKey(ctxMut.v);
      if (!key) return; // sandbox / demo call without entity context — skip persistence
      const payload = {
        ...key,
        room_name:  roomName,
        sip_call_id: ctxMut.sipCallId,
        turn_index: ctxMut.turnIndex++,
        role,
        text:       text || '',
        lang:       ctxMut.lang,
        tool_name, tool_args, tool_result, stt_confidence,
        started_at: new Date().toISOString(),
      };
      try {
        const res = await fetch(`${WEBHOOK_BASE}/webhook/livekit/turn`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(TOOL_SECRET ? { 'X-COD-Tool-Secret': TOOL_SECRET } : {}),
          },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          console.warn(`[turn-persist] HTTP ${res.status} for ${role} turn #${payload.turn_index}`);
        }
      } catch (err) {
        console.warn(`[turn-persist] fire-and-forget error on ${role} turn #${payload.turn_index}:`, err.message);
      }
    }

    const session = new voice.AgentSession({
      vad: ctx.proc.userData.vad,
      stt: buildSTT(initialLang),
      llm: new openai.LLM({
        // gpt-4.1-mini: newer, faster, better instruction-following than
        // gpt-4o-mini for the constrained COD dialogue. Override via
        // OPENAI_LLM_MODEL.
        model: process.env.OPENAI_LLM_MODEL || 'gpt-4.1-mini',
        temperature: 0.6,
        maxTokens: 60,
        apiKey: OPENAI_VOICE_KEY,
        baseURL: OPENAI_VOICE_BASE_URL,
      }),
      tts: buildTTS(initialLang),
      turnDetection: new livekit.turnDetector.MultilingualModel(),
      preemptiveGeneration: true,
      aecWarmupDuration: 500,
      minInterruptionWords: 3,
      // 750ms (was 600) so brief background noise / a cough doesn't count as the
      // customer barging in and cut the agent off mid-sentence.
      minInterruptionDuration: 750,
      // Endpointing caps. Without these the turn detector could hold the line
      // for many seconds after a short reply (e.g. "नहीं") — real calls showed
      // 7–20s of dead air before the agent responded, and customers hung up.
      // minDelay keeps it responsive; maxDelay HARD-caps how long the agent
      // waits to decide the customer is done before it speaks.
      minEndpointingDelay: parseInt(process.env.MIN_ENDPOINT_MS || '400', 10),
      // Lowered 3500→1500: the turn detector handles most end-of-turn detection;
      // this is just the hard cap on how long to wait before replying. 3.5s was
      // adding a ~2s dead pause after the customer finished. 1.5s is snappier
      // while still tolerating a brief mid-sentence pause.
      maxEndpointingDelay: parseInt(process.env.MAX_ENDPOINT_MS || '1500', 10),
    });

    let terminalToolFired = false;
    let hangupTimer = null;
    let voicemailDetected = false;
    let userTurnCount = 0;
    const autoHangupMs = parseInt(process.env.AUTO_HANGUP_MS || '10000', 10);

    // ── Silence / dead-air guards ─────────────────────────────────────────
    // A call where the customer never speaks (voicemail that doesn't transcribe,
    // dead air, one-way audio, or the SIP leg picked up by a machine) used to
    // sit open until the carrier timed out — ~2 min of paid VoIP for nothing,
    // and the operator hears "agent said hello, then silence". Two timers fix
    // it: NO_INPUT_HANGUP_MS bounds the wait for the FIRST user utterance after
    // the welcome; it then becomes a rolling idle timeout, reset on every user
    // turn. MAX_CALL_MS is an absolute backstop for a call that drags on (e.g.
    // a voicemail greeting that DOES transcribe, resetting the idle timer).
    // NO_INPUT_NUDGE_MS: after the welcome, if the customer stays silent this
    // long, the agent NUDGES ("Hello, can you hear me? Shall I confirm your
    // order?") instead of waiting mutely. Many customers heard the pitch, had
    // nothing to respond to, and the call died on dead air — the nudge
    // re-engages them. Only after a further NO_INPUT_HANGUP_MS of continued
    // silence do we hang up.
    const noInputNudgeMs  = parseInt(process.env.NO_INPUT_NUDGE_MS || '7000', 10);
    const noInputHangupMs = parseInt(process.env.NO_INPUT_HANGUP_MS || '20000', 10);
    const maxCallMs       = parseInt(process.env.MAX_CALL_MS || '150000', 10);
    let sawUserSpeech = false;
    let nudged        = false;
    let nudgeTimer    = null;
    let silenceTimer  = null;
    let maxCallTimer  = null;

    // Anti-loop guard. When the input is unintelligible (background voices,
    // crosstalk, garbled STT) the agent keeps saying "I didn't understand" and
    // burns the whole call in a confused loop (seen on a real 58s call). Count
    // consecutive "confusion" replies; after MAX_CONFUSION_TURNS, say a polite
    // close and hang up instead of looping.
    const maxConfusion = parseInt(process.env.MAX_CONFUSION_TURNS || '2', 10);
    let consecutiveConfusion = 0;
    let givingUp = false;
    const CONFUSION_RE = /समझ नहीं आ|समझ नहीं पा|समझ नहीं|सुनाई नहीं|दोबारा बोल|फिर से बोल|माफ़? कीज|didn'?t (catch|hear|understand)|could ?n'?t (catch|hear|understand)|come again|could you repeat|say that again/i;

    function hangupNow(reason) {
      const rn = ctx.room?.name;
      if (!rn) return;
      const lkUrl = process.env.LIVEKIT_URL;
      const lkKey = process.env.LIVEKIT_API_KEY;
      const lkSecret = process.env.LIVEKIT_API_SECRET;
      if (!lkUrl || !lkKey || !lkSecret) {
        console.warn(`[hangup] LIVEKIT_* env missing — cannot terminate room (${reason})`);
        return;
      }
      console.log(`[hangup] deleteRoom ${rn} — ${reason}`);
      const rs = new RoomServiceClient(lkUrl, lkKey, lkSecret);
      rs.deleteRoom(rn).catch(err =>
        console.log(`[hangup] deleteRoom (likely already closed): ${err.message}`)
      );
    }

    function clearSilenceGuards() {
      if (nudgeTimer)   { clearTimeout(nudgeTimer);   nudgeTimer = null; }
      if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
      if (maxCallTimer) { clearTimeout(maxCallTimer); maxCallTimer = null; }
    }

    // Initial post-welcome wait: nudge once (re-ask the question aloud), then
    // start the hangup countdown. If the customer speaks first, the nudge is
    // cancelled and armSilenceTimer() takes over as a rolling idle timer.
    function armInitialSilenceGuard() {
      if (terminalToolFired) return;
      if (nudgeTimer) clearTimeout(nudgeTimer);
      nudgeTimer = setTimeout(() => {
        nudgeTimer = null;
        if (terminalToolFired || sawUserSpeech) return;
        nudged = true;
        const text = (ctxMut.profileMod && typeof ctxMut.profileMod.buildReprompt === 'function')
          ? ctxMut.profileMod.buildReprompt(ctxMut.v, ctxMut.lang)
          : (ctxMut.lang !== 'hi-IN' ? 'Hello, are you able to hear me?' : 'Hello, क्या आप मुझे सुन पा रहे हैं?');
        console.log(`[silence] no reply ${noInputNudgeMs}ms after welcome — nudging customer`);
        try { session.say(text, { allowInterruptions: true }); } catch (e) { /* non-fatal */ }
        armSilenceTimer(); // start the hangup countdown after the nudge
      }, noInputNudgeMs);
    }

    // (Re)arm the rolling no-input / idle timer. Called once after the welcome
    // and again on every final user turn. A terminal tool (order confirmed/
    // cancelled) disarms it — that path owns the post-farewell hangup.
    function armSilenceTimer() {
      if (terminalToolFired) return;
      if (silenceTimer) clearTimeout(silenceTimer);
      silenceTimer = setTimeout(() => {
        if (terminalToolFired) return;
        hangupNow(sawUserSpeech
          ? `user idle ${noInputHangupMs}ms — silence hangup`
          : `no user speech ${noInputHangupMs}ms — voicemail/dead-air hangup`);
      }, noInputHangupMs);
    }

    function armMaxCallTimer() {
      if (maxCallTimer) clearTimeout(maxCallTimer);
      maxCallTimer = setTimeout(() => {
        if (terminalToolFired) return;
        hangupNow(`max call duration ${maxCallMs}ms — backstop hangup`);
      }, maxCallMs);
    }

    session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (ev) => {
      if (!ev.isFinal) return;
      const transcript = ev.transcript || '';
      console.log(`[user] ${transcript}`);
      userTurnCount++;
      // Customer is alive on the line — cancel the pending nudge and reset the
      // rolling idle timer.
      sawUserSpeech = true;
      if (nudgeTimer) { clearTimeout(nudgeTimer); nudgeTimer = null; }
      armSilenceTimer();

      if (!voicemailDetected && userTurnCount <= 4) {
        const matched = VOICEMAIL_PATTERNS.find(p => p.test(transcript));
        if (matched) {
          voicemailDetected = true;
          console.log(`[voicemail] detected on user turn #${userTurnCount}: "${transcript}" (matched ${matched})`);
          postTurn({
            role: 'tool',
            text: 'voicemail_detected',
            tool_name: 'voicemail_detected',
            tool_args: { transcript },
            tool_result: 'hangup',
          });
          hangupNow('voicemail detected');
          return;
        }
      }

      postTurn({
        role: 'user',
        text: transcript,
        stt_confidence: typeof ev.confidence === 'number' ? ev.confidence : undefined,
      });
    });

    session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (ev) => {
      if (ev.item?.role !== 'assistant') return;
      const text = ev.item.textContent ?? '';
      console.log(`[assistant] ${text.slice(0, 200)}`);
      postTurn({ role: 'assistant', text });

      // Anti-loop: track consecutive "I didn't understand" replies.
      if (!terminalToolFired && !givingUp) {
        if (CONFUSION_RE.test(text)) {
          consecutiveConfusion++;
          if (consecutiveConfusion >= maxConfusion) {
            givingUp = true;
            clearSilenceGuards();
            const close = (ctxMut.profileMod && typeof ctxMut.profileMod.buildGiveUpClose === 'function')
              ? ctxMut.profileMod.buildGiveUpClose(ctxMut.v, ctxMut.lang)
              : (ctxMut.lang !== 'hi-IN'
                  ? 'Sorry, I am not able to hear you clearly. We will call you again shortly. Thank you.'
                  : 'माफ़ कीजिए, आपकी आवाज़ साफ़ नहीं आ रही है। हम आपको थोड़ी देर में दोबारा call करेंगे। धन्यवाद।');
            console.log(`[anti-loop] ${consecutiveConfusion} consecutive unclear replies — closing gracefully`);
            try { session.say(close, { allowInterruptions: false }); } catch (e) { /* non-fatal */ }
            setTimeout(() => hangupNow('anti-loop: repeated unintelligible input'), 7000);
          }
        } else {
          consecutiveConfusion = 0;
        }
      }

      if (terminalToolFired && !hangupTimer) {
        const rn = ctx.room?.name;
        hangupTimer = setTimeout(async () => {
          try {
            if (!rn) return;
            const lkUrl = process.env.LIVEKIT_URL;
            const lkKey = process.env.LIVEKIT_API_KEY;
            const lkSecret = process.env.LIVEKIT_API_SECRET;
            if (!lkUrl || !lkKey || !lkSecret) {
              console.warn('[auto-hangup] LIVEKIT_* env missing — cannot terminate room');
              return;
            }
            console.log(`[auto-hangup] deleting room ${rn} after farewell — VoIP-minutes guard (${autoHangupMs}ms)`);
            const rs = new RoomServiceClient(lkUrl, lkKey, lkSecret);
            await rs.deleteRoom(rn);
          } catch (err) {
            console.log(`[auto-hangup] deleteRoom (likely already closed): ${err.message}`);
          }
        }, autoHangupMs);
      }
    });

    session.on(voice.AgentSessionEventTypes.FunctionToolsExecuted, (ev) => {
      const calls = ev.functionCalls || [];
      console.log('[tool]', calls.map(c => c.name).join(',') || '?');
      for (const c of calls) {
        postTurn({
          role:        'tool',
          text:        c.name || '',
          tool_name:   c.name,
          tool_args:   c.arguments ?? c.args ?? undefined,
          tool_result: typeof c.result === 'string' ? c.result : (c.result ? JSON.stringify(c.result) : undefined),
        });
        if (ctxMut.profileMod && ctxMut.profileMod.TERMINAL_TOOLS.has(c.name)) {
          terminalToolFired = true;
          console.log(`[auto-hangup] armed after terminal tool: ${c.name}`);
        }
      }
    });

    session.on(voice.AgentSessionEventTypes.Close, () => {
      if (hangupTimer) {
        clearTimeout(hangupTimer);
        hangupTimer = null;
      }
      clearSilenceGuards();
      console.log(`[livekit-agent] session closed after ${ctxMut.turnIndex} turns`);
    });

    // Serial start (the previous parallel-start attempt killed AgentActivity
    // before updateAgent could land — see git history for the bug). With TLS
    // prewarmed, serial cold-start is ~3-5s and the welcome reliably plays.
    const participant = await ctx.waitForParticipant();
    const attrs = participant.attributes || {};

    ctxMut.profileId = attrs.profile || DEFAULT_PROFILE_ID;
    ctxMut.lang = attrs.language || 'hi-IN';
    ctxMut.sipCallId = attrs.sip_call_id || null;

    let profileMod;
    try {
      profileMod = await loadProfileModule(ctxMut.profileId);
    } catch (err) {
      console.error(`[profile] failed to load "${ctxMut.profileId}":`, err.message);
      hangupNow(`profile load failed: ${err.message}`);
      return;
    }
    ctxMut.profileMod = profileMod;

    ctxMut.v = profileMod.renderContext(attrs, ctxMut.lang, process.env);
    const v = ctxMut.v;
    const lang = ctxMut.lang;
    console.log(`[livekit-agent] profile=${ctxMut.profileId} call for ${v.customer_name || '(no name)'} / ${v.order_number || attrs.entity_ref || '-'} lang=${lang}`);

    const realAgent = new voice.Agent({
      instructions: profileMod.buildSystemPrompt(v, lang),
      tools:        profileMod.buildTools(v, { WEBHOOK_BASE, TOOL_SECRET }),
    });

    const coldStartMs = Date.now();
    // Krisp Telephony Background-Voice-Cancellation on the SIP input track —
    // strips background HUMAN voices (family/TV chatter) before they reach STT,
    // the one thing VAD can't do. Telephony model is tuned for 8kHz narrowband.
    // Toggle off via NOISE_CANCELLATION=off if it ever regresses audio.
    const startOpts = { agent: realAgent, room: ctx.room };
    if ((process.env.NOISE_CANCELLATION || 'on').toLowerCase() !== 'off') {
      startOpts.inputOptions = { noiseCancellation: TelephonyBackgroundVoiceCancellation() };
      console.log('[noise-cancellation] Telephony BVC enabled on input track');
    }
    await session.start(startOpts);
    console.log(`[cold-start] serial-start: ${Date.now() - coldStartMs}ms (TLS prewarmed)`);

    const welcomeHandle = session.say(profileMod.buildWelcome(v, lang, process.env), { allowInterruptions: false });

    // Arm the dead-air guards ONLY AFTER the welcome finishes playing. Arming
    // them at welcome-start meant the NO_INPUT_NUDGE_MS timer ran DURING the
    // (now longer: product + amount + question) welcome, so the agent finished
    // its pitch and immediately blurted the nudge ("hello, kya aap mujhe sun
    // paa rahe hain…") — never pausing for the customer. Waiting for playout
    // gives the customer a real silence window to answer the question first.
    const armAfterWelcome = () => { armInitialSilenceGuard(); armMaxCallTimer(); };
    if (welcomeHandle && typeof welcomeHandle.waitForPlayout === 'function') {
      welcomeHandle.waitForPlayout().then(armAfterWelcome).catch(armAfterWelcome);
    } else {
      // Fallback if the SDK shape changes: assume a ~9s welcome before arming.
      setTimeout(armAfterWelcome, 9000);
    }
  },
});

cli.runApp(
  new ServerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName: process.env.LIVEKIT_AGENT_NAME || 'cod-confirm-priya',
    host: process.env.LIVEKIT_AGENT_HTTP_HOST || '127.0.0.1',
  }),
);
