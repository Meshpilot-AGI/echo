# Milestones — Mesh Pilot COD Confirm (Priya voice agent)

Hand-curated log of the voice-AI iteration for COD confirmation on an Indian
Shopify store.
Complements the auto-generated `CHANGELOG.md` (which is reset from `git log`
on every push). This file is human-kept, permanent, and survives the sync.

**Format:** newest on top, UTC dates, scope + outcome + what we learned.

---

## 2026-04-15 (later) — Devanagari script + bilingual mode (voice confirmed "much better")

- Moved all Hindi prompt content and welcome message from Latin-transliterated
  Hindi to native **Devanagari** script. Bulbul v3 was previously drifting
  `ke liye` → "thi liye" (a user-flagged mispronunciation). In Devanagari
  (`के लिए`) Sarvam renders correctly with proper vowels and stress.
- Added `language` participant attribute (`hi-IN` default, `en-IN`) plumbed
  from `/flow-test-livekit?lang=en-IN` → `trigger-livekit-call.js` →
  `livekit-agent.js`. Switches STT, TTS, prompt, and welcome as a set.
- Fixed "Namaste Hello" fallback bug when no customer name is passed.
- User feedback after this round: **"the voice feel much more better now"** ✓

## 2026-04-15 — LiveKit + Sarvam Bulbul v3 stack, native 8 kHz win

**Scope:** rebuild Priya on LiveKit Agents JS (Node.js) + Sarvam Bulbul v3 TTS
+ Sarvam Saaras v3 STT + GPT-4o-mini LLM + Vobiz SIP trunk. Migrate off the
prior managed platform after we hit limits we couldn't work around in time.

**Stack pieces now in production:**
- Agent: prior managed platform → `cod-confirm-priya` (LiveKit, alive)
- Telephony: Vobiz SIP trunk via LiveKit outbound trunk. DLT-registered caller-ID.
- TTS: Sarvam Bulbul v3, voice `neha`, **`sampleRate: 8000` native** — skips
  the 24k→8k resample that was the root cause of "sounds like a bot".
- STT: Sarvam Saaras v3, `hi-IN` (Hinglish code-switch handled natively).
- LLM: OpenAI gpt-4o-mini @ 0.6 temp.
- Turn detection: `livekit.turnDetector.MultilingualModel` (Hindi-safe).
- VAD: Silero (prewarmed once per worker process).

**Tools wired end-to-end:** `confirm_order`, `cancel_order`, `request_human_agent`,
`request_callback` — all POST to `/webhook/livekit/tool/*` in `src/server.js`
and reuse the existing `updateOrderTag()` for Shopify write-back.

**Outbound trigger:** `GET /flow-test-livekit?shop=…&order=…&phone=+91…`
(in `src/server.js`), wraps `SipClient.createSipParticipant` with
Shopify-derived participant attributes so Priya knows customer name / order #
/ amount / product / address.

**What moved the needle today:**
1. **Moving to LiveKit + self-hosted agent worker** — gave us direct control
   over the audio pipeline, tool configuration, and call dispatch. The
   managed option we tried first couldn't meet our bar in time; LiveKit +
   Sarvam let us ship.
2. **Getting Sarvam v3 voice names right** — `anushka` / `manisha` /
   `vidya` / `arya` are v1/v2 legacy voices that Sarvam's REST API accepts
   but its **WebSocket streaming endpoint rejects with 422**. Native v3
   female voices: `ritu, priya, neha, pooja, simran, kavya, ishita, shreya,
   roopa, amelia, sophia, tanya, shruti, suhani, kavitha, rupali`.
3. **Native 8 kHz output** (biggest quality jump) — LiveKit plugin defaults
   to 24 kHz then resamples down for the SIP leg. That resample is lossy
   and is what made Sarvam sound robotic. Setting `sampleRate: 8000` on the
   `sarvam.TTS` constructor matches Sarvam's own cookbook config and removes
   the artifact.
4. **`ctx.connect()` before `ctx.waitForParticipant()`** — not documented
   clearly in the Node.js agent quickstart; agent entry fails with
   "room is not connected" without it.
5. **`preemptiveGeneration: true`** (LiveKit default) is necessary — setting
   it `false` added ~10 s startup delay that made users hang up before
   Priya spoke. Don't touch.

**What didn't work (learn, don't repeat):**
- `temperature: 1.2` on `sarvam.TTS` + `enablePreprocessing: true` — both
  silently breakk the streaming WS (client appears to connect but never gets
  audio back). Per Sarvam's cookbook, only `pace` and `speech_sample_rate`
  are universally safe on v3 streaming.
- Legacy v1/v2 voice names (see above) — WS 422.

**User feedback after first real PSTN test (brother's Indian SIM):**
- "much better than all previous tests" ✓ (the 8 kHz fix)
- Missing: Priya didn't say the amount (that test was the LiveKit browser
  playground, which doesn't pass `participantAttributes`; on PSTN the
  amount is passed correctly).
- Next: prompt should explicitly confirm the **delivery address** back to
  the customer before final confirmation — #1 RTO prevention lever.

## Deferred / known bot-ceiling

Sarvam Bulbul v3 streaming at 8 kHz is now indistinguishable-enough for
the current deployment. If a future client demands "cannot tell it's AI" quality,
the next jump is **OpenAI Realtime** (speech-to-speech via
`openai.realtime.RealtimeModel`) — one-file swap in `src/livekit-agent.js`,
with a tradeoff: native-sounding English but a subtle non-Indian accent on
Hindi words, plus ~2× cost per minute. Not worth doing until a client asks.

---

## 2026-04-15 (earlier) — Managed-platform baselines, then pivot to self-hosted

- Tried a managed voice-agent platform with ElevenLabs TTS over the Indian
  PSTN leg. Voice quality wasn't where we needed it for our use case —
  couldn't hit the naturalness bar even after tuning interruption
  sensitivity, backchannels, speed, normalisation, and ambient noise.
- Researched Hindi telephony TTS — Sarvam Bulbul v3 kept coming up as the
  strongest option for 8 kHz Hindi prosody (ahead of ElevenLabs v3 and
  Cartesia Sonic-3 on the benchmarks we cared about). Tried a different
  managed platform that wraps Sarvam natively.
- Hit limits on that platform around tool configuration and SIP dispatch
  we couldn't work around in time. Pivoted to self-hosted LiveKit + Sarvam,
  which is where we ended the day.

---

## Architecture diagram (current)

```
Shopify order → /webhook/shopify/orders-create (existing)
    ↓ 10 min delay
Our Express server (cod-confirm.service) → POST /call to LiveKit SDK
    ↓ SipClient.createSipParticipant(trunk, phone, room, participantAttributes)
    ↓ LiveKit Cloud → SIP INVITE → Vobiz trunk → customer PSTN
        ↓ customer answers → RTP bridged into LiveKit room
LiveKit Cloud dispatches our agent worker (cod-confirm-agent.service) →
    Sarvam Saaras v3 STT  ←  customer audio
    GPT-4o-mini LLM
    Sarvam Bulbul v3 TTS @ 8kHz  →  customer audio
    Tools: confirm_order / cancel_order / request_human_agent / request_callback
        ↓ HTTP POST → Express /webhook/livekit/tool/*
        ↓ updateOrderTag() → Shopify GraphQL orderUpdate
Call ends → Priya hangs up → Shopify order is tagged within ~2s
```
