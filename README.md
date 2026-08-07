# Mesh Pilot Voice

**Multi-profile AI voice agent platform. One engine, many use cases — call customers about COD orders, appointment reminders, lead qualification, support callbacks, anything voice-shaped.**

The engine handles the universal hard parts of an AI voice call: SIP audio at 8kHz, real-time STT/LLM/TTS plumbing, turn detection, AEC, voicemail handling, auto-hangup, recording egress, transcript persistence, DND-aware scheduling, retry logic. Each "use case" is a self-contained **profile** under `profiles/<id>/`: prompt, tools, triggers, post-call hooks. Adding a new use case is config + a `prompts/` dir — zero engine changes.

## Profiles shipped today

| Profile | Persona | Stack | Purpose |
|---|---|---|---|
| `cod-confirm` | Priya | **Retell AI** + Vobiz SIP | Calls Indian COD customers ~10 min after a Shopify order, confirms before dispatch. Cuts RTO 25–40% → much lower. **Flagship — production-tested.** Production runtime is **Retell** (`COD_CONFIRM_RUNTIME=retell`); the original in-house LiveKit loop is the legacy fallback. |
| `concierge` | Alex | Twilio ConversationRelay | General-purpose **international (US/+1)** English agent. The call's *purpose* is supplied per-dispatch (`payload.goal` + `context`), so the same agent confirms deliveries, follows up carts, qualifies leads, handles support, etc. Twilio owns telephony + ASR + ElevenLabs TTS; our relay server runs the LLM brain. |
| `appointment-remind` | Maya | LiveKit | Calls ~24h before a booked appointment. Confirms, captures reschedule slot, or cancels cleanly. Demonstrates the abstraction; production wiring (Google Calendar / CRM) plugs in when a paying customer ships. |

## Two telephony stacks

The platform runs **two distinct call paths**, chosen per call by the profile:

| Destination | Path | Why |
|---|---|---|
| `+91` (India) — `cod-confirm` | **Retell AI orchestration + Vobiz SIP trunk** | Retell owns the realtime STT/LLM/TTS/turn-taking loop; Vobiz provides the DLT-registered Indian caller ID (TRAI requirement). Selected by `COD_CONFIRM_RUNTIME=retell` (production default). The original in-house **LiveKit Agents** loop stays wired as the legacy fallback (`=livekit`). |
| International (`+1`/US) — `concierge` | **Twilio ConversationRelay** (no LiveKit) | Twilio owns the telephony + ASR + ElevenLabs TTS; our WebSocket relay server (`src/relay-server.js`) is just the LLM brain. Sidesteps the SIP/codec/SRTP plumbing and gives clean PSTN audio out of the box. |

The scheduler picks the path in `dispatchOne()`: `profile === 'concierge'` → `triggerRelayCall` (Twilio ConversationRelay TwiML); otherwise `COD_CONFIRM_RUNTIME=retell` → `triggerRetellCall` (Retell + Vobiz SIP — the production default) and `=livekit` → `triggerLivekitCall` (legacy in-house SIP loop). All three return the same `{ ok, room_name, sip }` shape so the scheduler's bookkeeping (CallAttempt, outcome) is identical.

> Part of **[Mesh Pilot](https://meshpilot.app)** — the AI marketing-operations platform by **Nuraveda Labs**.

---

## What it does

The rest of this README describes the `cod-confirm` profile — the flagship use case the platform was originally extracted from. Other profiles follow the same structure; see [Adding a new profile](#adding-a-new-profile) below.

```
Shopify orders/create webhook (HMAC-verified, COD-only)
        │
        ▼  (10-min delay, DND-aware scheduler, per-shop allowlist)
LiveKit room created  +  outbound SIP call to customer
        │
        ▼  (room-composite egress recording → R2)
Customer answers
        │
        ▼  (greeting, then turn-by-turn:)
   ┌─────────────┬─────────────┐
   ▼             ▼             ▼
Retell STT   gpt-4.1 speak   ElevenLabs TTS
(hi/en)      gpt-5.1 intent  (custom voice,
 Retell-VAD  Conversation    multilingual_v2)
             Flow
   │             │             │
   └─────────────┼─────────────┘
                 ▼
        4 tool calls available:
   confirm_order · cancel_order ·
   request_human_agent · request_callback
                 │
                 ▼
      Shopify GraphQL orderUpdate
        (tag + note, ~2s)
                 │
                 ▼
        Auto-hangup ~10s after farewell
        (don't burn VoIP minutes on
         customers who hold the line)
```

**"Priya"** is a bilingual (Hindi/English) voice agent that:

1. Calls the customer ~10 minutes after order placement (DND-window aware)
2. Confirms product, amount, and delivery address in natural Hinglish
3. Handles cancellations / objections / human-agent requests / callback requests
4. Writes outcome tags to the Shopify order via GraphQL
5. Records every call to R2 + persists every conversation turn to PostgreSQL — building a paired (audio, transcript, outcome) corpus for future fine-tuning

---

## Stack — production runtime (Retell)

`cod-confirm` runs on **Retell AI** in production (`COD_CONFIRM_RUNTIME=retell`). Retell
orchestrates the entire realtime loop (STT, LLM, TTS, turn-taking, VAD); we drive it
over our **Vobiz SIP** trunk for the DLT-registered Indian caller ID. We own the
**Conversation Flow** (prompts + nodes + tools), the voice, and the dynamic variables.

| Layer | Production value | Notes |
|---|---|---|
| **Orchestrator** | [Retell AI](https://retellai.com) Conversation-Flow agent (`agent_510ac247…`, flow `conversation_flow_2d02bf9e4676`) | One agent; nodes = greeting → confirm → intent (subagent, 4 tools) → close. Driven via the official `retell-sdk`. |
| **LLM (speaking nodes)** | `gpt-4.1` (cascading) | Fast time-to-first-token for the scripted lines (greeting / confirm / closes). |
| **LLM (intent decision)** | `gpt-5.1` (per-node override on `intent_parse`) | The one turn that classifies confirm/cancel/callback/human needs the sharper model + a hard negation guard ("`cancel नहीं करना`" = KEEP, never cancel). |
| **TTS** | [ElevenLabs](https://elevenlabs.io) custom voice (`custom_voice_0165…`), `eleven_multilingual_v2` | Most stable ElevenLabs model for **Hindi** prosody. `voice_temperature 0.3`, dynamic voice-speed **off** for steady, drop-free delivery. |
| **STT** | Retell-managed, `stt_mode=accurate` | `accurate` (not `fast`) — fast garbled Hindi into wrong tokens; accuracy beats the small latency gain on the decision turn. |
| **Prompts** | All Hindi in **Devanagari** (देवनागरी), never roman | ElevenLabs mispronounces Latin-script Hindi; an unresolved-`{{placeholder}}` rule substitutes a natural generic so a missing var never reads as literal "product". |
| **Dynamic variables** | `retell_llm_dynamic_variables` in `create-phone-call` | Order context (product → `चश्मे`, amount → Hindi words) normalized by `speakable.js` / `spoken-numbers.js`, with non-empty fallbacks. |
| **Telephony** | Vobiz SIP trunk (BYOC; no phone number registered in Retell — agent bound per-call via the body) | DLT-registered Indian caller ID. |
| **Config-as-code** | `retell/agent.config.json` + `retell/flow.config.json` | Live agent/flow captured to versioned JSON; `pnpm retell:capture` (live→repo) / `pnpm retell:apply` (repo→live, dry-run by default). Tool secret redacted in git, rehydrated on apply. See `retell/README.md`. |
| **Eval suite** | `retell/eval/test-cases.json` + `pnpm retell:eval:seed` / `:run` | 8 simulated-caller personas (confirm, cancel, refuse-to-cancel, callback, human, garbled-positive, PII probe, wrong-product) batch-tested against the flow. See `retell/eval/README.md`. |

> **Latency note.** Compute latency (LLM + endpointing) is tuned above. The remaining
> floor is the **Vobiz → India PSTN carrier leg** (narrowband, jitter) — no agent
> setting removes it; that's a carrier-side fix.

---

## Stack — legacy runtime (LiveKit, `COD_CONFIRM_RUNTIME=livekit`)

Kept wired as a fallback. This was the original in-house loop before the Retell cutover;
the international `concierge` stack is summarised in [Two telephony stacks](#two-telephony-stacks).

| Layer | Default | Notes |
|---|---|---|
| **Agent framework** | [LiveKit Agents JS](https://github.com/livekit/agents-js) v1.4.5 | Real-time WebRTC + first-class SIP, Node.js SDK. Upgraded 1.2.6 → 1.4.5 (Scribe STT, newer turn detector, Krisp BVC). |
| **TTS (production)** | [ElevenLabs](https://elevenlabs.io) `eleven_flash_v2_5` (`pcm_8000`) | Flash = ultra-low-latency conversational model — cuts TTS first-byte latency on telephony. Override via `ELEVENLABS_MODEL` (e.g. `eleven_turbo_v2_5` for a touch more quality at higher latency). |
| **TTS (fallback)** | [Sarvam](https://sarvam.ai) Bulbul v3 (`neha`, native 8kHz) | Kept wired; flip `TTS_PROVIDER=sarvam` for vendor-outage recovery |
| **STT** | Sarvam Saaras v3 for `hi-IN`; OpenAI `gpt-4o-transcribe` for English (`en-IN`/`en-US`) | Sarvam is best-in-class for Hindi/Hinglish; English routes through OpenAI's Whisper-based transcribe. (The `concierge` stack uses ElevenLabs **Scribe** via Twilio/Deepgram ASR.) |
| **LLM** | OpenAI `gpt-4.1-mini` (token-capped) | Token cap mechanically enforces the "≤12 word sentences" prompt rule |
| **Turn detection** | LiveKit Multilingual Model | Hindi-safe end-of-turn detection; `min/maxEndpointingDelay` tuned for phone latency |
| **VAD** | Silero (prewarmed per worker, 8kHz) | Matches SIP sample rate — no resample step |
| **Noise cancellation** | Krisp `TelephonyBackgroundVoiceCancellation` (BVC) | `@livekit/noise-cancellation-node` — telephony-tuned background-voice removal |
| **Telephony** | Vobiz SIP trunk via LiveKit outbound | DLT-registered Indian caller ID |
| **Backend** | Express.js + Prisma + PostgreSQL | Webhooks, scheduler, per-shop sessions, turn-by-turn transcript persistence |
| **Audio storage** | Cloudflare R2 (S3-compatible, $0 egress) | MP4/Opus room-composite recordings |
| **Shopify** | Custom App per shop (`orders/create` webhook) | Per-shop HMAC verification, allowlist gate |

---

## Quickstart

### Prerequisites

- Node.js 20+ · pnpm · PostgreSQL
- **Production (Retell runtime, `COD_CONFIRM_RUNTIME=retell`):** a Retell AI account
  (`RETELL_API_KEY`, `RETELL_AGENT_ID`) + the Vobiz SIP trunk number (`VOBIZ_FROM_NUMBER`).
  Manage the agent/flow config via `pnpm retell:capture` / `pnpm retell:apply` (see `retell/`).
- **Legacy (LiveKit runtime, `=livekit`):** a LiveKit Cloud project + a SIP trunk (Vobiz
  or any DLT-registered Indian provider) + API keys for Sarvam (STT), ElevenLabs **or**
  Sarvam (TTS), OpenAI (LLM).
- A Cloudflare R2 bucket (optional, for recordings)
- A Shopify Custom App per store (`read_orders` + `write_orders`)

### Install

```bash
git clone https://github.com/floating-astronaut/meshpilot-digital-marketing-stack.git
cd meshpilot-digital-marketing-stack/apps/cod_confirm
pnpm install
cp .env.example .env
# Edit .env (see "Configuration" below)
npx prisma generate
npx prisma db push

# Optional: copy the demo prompts as your starting point
cp prompts/hindi-prompt.example.txt   prompts/hindi-prompt.txt
cp prompts/english-prompt.example.txt prompts/english-prompt.txt
```

### Run (processes)

```bash
# 1. Express webhook server (Shopify webhooks + tool endpoints + scheduler/dispatch).
#    On the production Retell runtime (COD_CONFIRM_RUNTIME=retell) this is the ONLY
#    process you need — Retell hosts the realtime voice loop; we just place the call.
node src/server.js

# 2. (legacy LiveKit runtime only, COD_CONFIRM_RUNTIME=livekit) LiveKit agent worker.
#    NOT used in production — Retell replaces this whole loop.
node src/livekit-agent.js start

# 3. (international only) Twilio ConversationRelay backend — the concierge LLM brain.
#    Only needed if you dispatch the `concierge` profile to +1/US numbers.
node src/relay-server.js
```

Production: systemd unit `cod-confirm.service` (server) lives in `systemd/`. On the Retell
runtime that's all that's required. The legacy `cod-confirm-agent.service` (LiveKit worker)
is only needed under `COD_CONFIRM_RUNTIME=livekit`; the relay backend runs as
`cod-confirm-relay.service` (system-wide, fronted by nginx at `wss://…/relay/ws`) for `concierge`.

### Test without burning real-customer minutes

```bash
# Dry-run the scheduler — logs what would dispatch, never places PSTN calls
DISPATCH_MODE=dry_run node src/server.js

# Place a real PSTN call to YOUR phone using a real order's context
# (bypasses dispatch_mode + DND for one-off testing)
curl "http://localhost:3104/flow-test-livekit?\
shop=your-store.myshopify.com&order=%231234&phone=%2B91XXXXXXXXXX&lang=hi-IN"
```

---

## Configuration

### Core (single-shop deploys can stop here)

```bash
# LiveKit
LIVEKIT_URL=wss://your-project.livekit.cloud
LIVEKIT_API_KEY=APIxxxxxxxx
LIVEKIT_API_SECRET=your_api_secret
LIVEKIT_SIP_TRUNK_ID=ST_...
LIVEKIT_AGENT_NAME=cod-confirm-priya
LIVEKIT_TOOL_SECRET=<random 32-byte hex>      # agent ↔ server tool auth

# TTS — production default is ElevenLabs; flip to Sarvam in 10 seconds for
# outage recovery without redeploying.
TTS_PROVIDER=elevenlabs                       # elevenlabs | sarvam
ELEVEN_API_KEY=sk_...
ELEVENLABS_VOICE_ID=<voice-id-from-your-library>
# ELEVENLABS_MODEL=eleven_flash_v2_5          # optional; default flash (low-latency). Set eleven_turbo_v2_5 for higher quality.

# STT (Sarvam is required regardless of TTS provider)
SARVAM_API_KEY=sk_...

# LLM
OPENAI_API_KEY=sk-...

# SIP trunk
VOBIZ_SIP_HOST=...
VOBIZ_SIP_USERNAME=...
VOBIZ_SIP_PASSWORD=...
VOBIZ_FROM_NUMBER=+91XXXXXXXXXX               # DLT-registered

# Database
DATABASE_URL=postgresql://user:pass@127.0.0.1:5432/cod_confirm?schema=public

# Server
PORT=3104
COD_CONFIRM_WEBHOOK_BASE=https://your-domain.com/cod-confirm

# Single-store branding (used as fallback when STORE_BRANDING doesn't list a shop)
STORE_NAME="Your Store"
STORE_CATEGORY="online store"

# Dispatch mode (dry_run = log only, live = real PSTN calls via scheduler)
DISPATCH_MODE=dry_run

# DND window (IST hours; default 20:00–10:00 — humane, not just TRAI's 9pm cutoff)
DND_START_HOUR=20
DND_END_HOUR=10

# Recording (optional — Cloudflare R2 recommended for $0 training-pull egress)
RECORDING_BACKEND=r2                          # r2 | s3 | gcp | "" (off)
RECORDING_BUCKET=your-bucket
RECORDING_PREFIX=cod-confirm/
R2_ACCOUNT_ID=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...

# DPDP Act consent disclosure played at greeting (default on)
RECORDING_CONSENT_DISCLOSURE=on

# Auto-hangup grace window after farewell (ms; default 10000)
AUTO_HANGUP_MS=10000

# Scheduler concurrency (default 1 — Vobiz / single-trunk safe;
# raise carefully after testing trunk capacity)
SCHEDULER_MAX_PER_TICK=1
```

### Multi-tenant (two or more shops on one agent)

```bash
# Allowlist — webhooks from shops not in this list are rejected (HTTP 403)
ALLOWED_SHOPS=shop-a.myshopify.com,shop-b.myshopify.com

# Per-shop webhook secret (one-app-per-shop is the Shopify recommendation)
SHOPIFY_WEBHOOK_SECRETS={"shop-a.myshopify.com":"shpss_aaa","shop-b.myshopify.com":"shpss_bbb"}

# Per-shop branding — the name Priya speaks + the category in the prompt
STORE_BRANDING={"shop-a.myshopify.com":{"name":"Shop A","category":"fashion store"},"shop-b.myshopify.com":{"name":"Shop B","category":"online store"}}
```

When a webhook arrives from `shop-a.myshopify.com`, the scheduler dispatches with `store_name="Shop A"` flowing into the system prompt; Priya says *"नमस्ते, मैं Priya बोल रही हूँ Shop A से..."*. No code changes per shop.

### One-time setup commands

```bash
# Create the SIP trunk in LiveKit (prints the LIVEKIT_SIP_TRUNK_ID for .env)
node src/create-sip-trunk.mjs

# Configure LiveKit Cloud webhook → https://your-domain.com/cod-confirm/webhook/livekit/egress-ready
# Enable: room_started, participant_joined, egress_started, egress_updated, egress_ended
```

---

## Repo layout

```
src/
├── server.js                  Express: Shopify webhooks, tool endpoints, LiveKit
│                              webhooks, /calls/dispatch, /health, /flow-test-livekit
├── livekit-agent.js           LiveKit worker: profile-agnostic session loop —
│                              STT/LLM/TTS wiring, buildSTT/buildTTS, prompt rendering,
│                              endpointing/turn-detection, silence nudge, auto-hangup guard.
│                              Loads each profile's agent.js dynamically (loadProfileModule).
├── trigger-livekit-call.js    Outbound SIP + recording egress initiator (India/LiveKit path)
├── relay-server.js            Twilio ConversationRelay backend (port 3105): WS at /relay/ws
│                              runs the concierge LLM brain, persists CallTurn, marks outcome
├── trigger-relay-call.js      Builds ConversationRelay TwiML + places the +1 call (intl path)
├── register-shopify-webhooks.mjs  Register/repair orders/create webhooks per shop
├── create-sip-trunk.mjs       One-time Vobiz/LiveKit trunk setup
├── create-twilio-trunk.mjs    One-time Twilio Elastic SIP / LiveKit trunk setup (SRTP-aware)
└── lib/
    ├── shops.js               Allowlist + getShopBranding(shop) helper
    └── scheduler.js           DND-aware scheduler, retry logic, atomic outcome writes,
                               concierge vs SIP dispatch branch + concurrency cap

profiles/                      Self-contained use cases (engine is profile-agnostic)
├── cod-confirm/               Priya — flagship India COD (LiveKit/Vobiz)
├── concierge/                 Alex — international en-US (Twilio ConversationRelay)
├── appointment-remind/        Maya — appointment reminders (reference 2nd profile)
└── README.md                  The profile contract
   each profile: profile.json · agent.js · index.js · prompts/ · lib/

prisma/
└── schema.prisma              Session · ScheduledCall · CallAttempt · CallTurn

systemd/
├── cod-confirm.service        Express server unit
└── cod-confirm-agent.service  LiveKit agent worker unit
   (cod-confirm-relay.service for the ConversationRelay backend is installed system-wide)

scripts/                       One-off operational scripts (backfill-cod-day.mjs, demos, …)
```

---

## International concierge stack (Twilio ConversationRelay)

The `concierge` profile does **not** use LiveKit. International (+1/US) calls run on
**[Twilio ConversationRelay](https://www.twilio.com/docs/voice/twiml/connect/conversationrelay)**:
Twilio owns the PSTN leg, ASR, and ElevenLabs TTS; our WebSocket server is the LLM brain.

```
/calls/dispatch  (profile=concierge, payload.goal + context)
        │
        ▼  triggerRelayCall() builds TwiML:
   <Start><Recording dual-channel/></Start>
   <Connect><ConversationRelay
       url=wss://…/relay/ws
       ttsProvider=ElevenLabs voice=<id>
       transcriptionProvider=Deepgram speechModel=nova-2-phonecall
       welcomeGreeting="…"><Parameter …/></ConversationRelay></Connect>
        │
        ▼  Twilio places the call, streams events to our relay server (src/relay-server.js)
   setup → prompt(voicePrompt) → [our gpt-4.1-mini turn] → {type:text} tokens back
        │                                                  └─ {type:end} hangs up
        ▼
   terminal tool (complete_call · request_callback · escalate_human)
        → markScheduledCallOutcome() · CallTurn rows persisted by shop/entity_ref
```

- **Relay server**: `src/relay-server.js`, port **3105**, WS path `/relay/ws`, health at
  `/relay/healthz`; systemd `cod-confirm-relay.service`, fronted by nginx (`wss://…/relay/ws`,
  WS upgrade + long read timeout).
- **Per-call purpose**: `payload.goal` + `payload.context` (+ optional `opening_line`) are
  passed as `<Parameter>`s and read on the `setup` event — the same agent does delivery
  confirmation, cart follow-up, lead-qual, support, etc. without code changes.
- **Recording**: ConversationRelay **ignores** the REST `record:true` flag — recording must be
  started in TwiML via `<Start><Recording recordingChannels="dual">` *before* `<Connect>`.
  Toggle with `RELAY_RECORDING=off`; set `RELAY_RECORDING_STATUS_CALLBACK` to sync to R2.
- **Why not SIP?** The Twilio Elastic-SIP-into-LiveKit path hit SRTP/codec friction (488
  "secure media required", μ-law distortion on the linear-PCM LiveKit pipeline).
  ConversationRelay gives clean telephony audio natively and removes the codec dance.

## Key engineering decisions

### Two-repo split: open engine, proprietary prompts

The architecture is open source. The actual tuned Hindi/English prompts — the IP that compounds with every call — live in a private repo and are loaded at runtime from `prompts/<lang>-prompt.txt`. The public repo ships `prompts/<lang>-prompt.example.txt` (deliberately generic demo prompts) so the engine stays runnable end-to-end for anyone cloning it.

`buildSystemPrompt()` reads `prompts/<lang>-prompt.txt` first; if absent, falls back to the `.example.txt` with a warning. This is the canonical pattern that other "engine open, tuning closed" projects (Stripe, Supabase) use, and it draws a clean line so future prompt iterations stay proprietary without retroactively trying to scrub git history.

See `prompts/README.md` for the placeholder convention.

### Speakable product names

Shopify SKUs are catalog-friendly but TTS-hostile (*"Maybach Frame Karan Aujla Edition Luxury Sunglass With Original Packing"*). The `speakableProduct(raw, lang)` helper maps the SKU through a category keyword table to a single spoken noun (`चश्मे` / `sunglasses`) before it ever reaches the prompt. Brand words never reach TTS, so they can't be mispronounced.

Unknown SKUs fall back to the first 3 words with a console warning — loud enough that you'll add the new category the first time it appears.

### Numbers spoken as words

`hindiRupees(2350)` → `"दो हज़ार तीन सौ पचास रुपय"` — fully expanded, no digits anywhere. Earlier hints like `"2350 रुपय (Hindi words: 2 हज़ार 350 रुपय)"` had the LLM read the digit prefix verbatim. Deterministic conversion (1 to 99,99,999) means the LLM has no other option than to speak words.

### Cancel needs a re-confirmation turn

`cancel_order` requires three steps in the prompt: (1) probe reason, (2) explicit yes/no re-confirmation, (3) only then fire the tool. STT misheard *"मैंने ही किया था"* as *"मैंने नहीं किया था"* in real testing — a single mistranscribed word would otherwise cancel a legitimate order. Two utterances now have to mishear in a row, which is much rarer.

### STT-affirmative tolerance

Sarvam Saaras in `hi-IN` mode often mangles English words spoken by Hindi customers (`"confirm confirm"` → `कंपं कंपं`). The prompt explicitly tells the LLM to treat short garbled tokens (`कंपं / कंफर्म / यस / ओके / श्योर / राइट`) as YES when they appear in response to a yes/no question and no negative cue is present. Negative direction is still gated by the skepticism rule above.

### Auto-hangup after farewell

Without explicit hangup the SIP leg stays open until the *customer* presses end. Customers who set the phone down thinking the call was over (common) burned VoIP minutes for as long as the trunk would tolerate. Now: any of the 4 terminal tools arms a one-shot `RoomServiceClient.deleteRoom` timer (`AUTO_HANGUP_MS`, default 10s) on the next assistant turn. If the customer hangs up first, the timer is cleared in the session-close handler.

### Tool call must precede farewell

Hard rule in the prompt and re-validated by the testing pattern: `confirm_order` / `cancel_order` / `request_human_agent` / `request_callback` MUST fire in the same LLM turn as the customer's final yes — not after. Otherwise customers hung up on the *"ठीक है, confirm कर रही हूँ"* line and the order never got tagged.

### TLS prewarm at child-process spawn

Child job processes pre-spawned by LiveKit each fire `HEAD` requests against `api.sarvam.ai`, `api.elevenlabs.io`, `api.openai.com` during `prewarm()`. This primes Node's TLS session cache + DNS resolver, cutting per-call WS upgrade latency by a couple of seconds.

### 8kHz native audio (matches SIP)

Both Sarvam (`sampleRate: 8000`) and ElevenLabs (`encoding: 'pcm_8000'`) generate audio natively at 8kHz. Avoids the 24k → 8k resample that introduces robotic artifacts on PSTN. Silero VAD is also configured for 8kHz to skip its own resample step.

### Backchannel-tolerant interruptions

`minInterruptionWords: 3` + `minInterruptionDuration: 600`. Indian customers backchannel heavily (*"हाँ हाँ"* / *"accha"* / *"ji ji"* while the agent is still speaking) — politeness, not interruption. Both gates must cross to count as a real barge-in. Real objections (*"nahi chahiye"*, *"mujhe nahi chahiye"*) are 3+ words and pass through.

### Welcome is non-interruptible

`session.say(welcome, { allowInterruptions: false })`. A real call (#9022) showed customers pressing phone buttons during the greeting; the DTMF tone passed VAD → speech interrupted → STT got no transcribable text → LLM had nothing to respond to → AgentActivity exited → 11s of dead air → customer hung up. Making the ~10s greeting non-interruptible avoids the entire failure path. Subsequent turns stay interruptible.

### Welcome is a short presence check — never pitch into a voicemail

The greeting (`buildWelcome`) only greets and asks *"do you have a quick minute?"* — it
states **no order details**. The order readback (product, amount, address) lives entirely
in the LLM-driven flow (prompt **Step 0 → Step 1**) and only begins **after a human
responds**. A voicemail never answers "haan", so it only ever hears the greeting and the
silence guard then hangs up — order details are never dumped onto an answering machine.
The prompt makes this explicit ("Voicemail पर order details कभी मत छोड़ो" / "Never leave
order details on a voicemail").

### Silence nudge armed *after* the welcome finishes playing

The "are you still there?" nudge timer is armed off `welcomeHandle.waitForPlayout()`, not
at welcome start. A longer greeting used to outrun a fixed timer, so the nudge fired
immediately after the agent's own pitch ("…hello, kya aap sun paa rahe hain?"). Arming
after playout completes ties the silence window to *actual* dead air, not wall-clock.

### AEC warmup at 500ms (not 3000ms default)

LiveKit's default disables interruptions for the first 3 seconds of every agent turn for echo-canceller stabilization. Reduced to 500ms — enough to settle on a SIP call while keeping barge-in responsive from the first half-second of each turn.

### Devanagari in prompts (not Latin transliteration)

Hindi phrases are written `के लिए` (Devanagari) not `ke liye` (Latin). Bulbul v3 and Samisha both pronounce Devanagari with correct vowel length / stress; Latin transliteration drifted to mispronunciations in testing.

### The moat is the data

Prompts are a commodity. Per-call assets:
- **Audio** — MP4/Opus in R2 keyed by LiveKit room name
- **Transcript** — `CallTurn` rows in PostgreSQL keyed by room name (one row per agent/customer/tool turn)
- **Outcome** — `ScheduledCall.outcome` after the terminal tool fires

This paired (audio, transcript, outcome) corpus is what gets fine-tuned into proprietary STT/TTS/LLM weights over time — none of which a competitor cloning the public repo can replicate without similar call volume.

---

## Multi-tenant

Onboarding a second (third, fourth) Shopify store:

1. Install the Custom App on the store (`read_orders` + `write_orders` scopes); `Session` row is created in PostgreSQL with the per-shop access token.
2. Add the shop's myshopify domain to `ALLOWED_SHOPS`.
3. Add the per-shop webhook secret to `SHOPIFY_WEBHOOK_SECRETS` JSON map.
4. Add the per-shop branding to `STORE_BRANDING` JSON map: `{"name":"Brand Name","category":"online store"}`.
5. Restart the Express service (the LiveKit agent worker doesn't need restart — branding flows through SIP participant attributes per call).

No code changes. The scheduler resolves `getShopBranding(row.shop)` per dispatch. At ~10+ stores this env-var JSON should move to a Shopify metafield-based lookup at dispatch time; until then JSON is fine.

---

## Shopify integration

1. Create a Custom App per store (one app per shop, per Shopify's recommendation — never share a single app across stores)
2. Subscribe the `orders/create` webhook to:
   `https://your-domain.com/cod-confirm/webhook/shopify/orders-create`
3. Add the shop to `ALLOWED_SHOPS` and the secret to `SHOPIFY_WEBHOOK_SECRETS` (see Multi-tenant above)

Tags written to the order after each conversation:

| Tag | Meaning |
|---|---|
| `cod-confirmed` | Customer confirmed; ship it |
| `cod-cancelled` | Customer cancelled (reason in note) |
| `cod-agent-needed` | Needs human follow-up (details in note) |
| `cod-callback-requested` | Customer wants a callback (time in note) |

---

## Data pipeline

Every call produces three assets keyed by LiveKit room name:

```
CallTurn        room_name · turn_index · role · text
                · tool_name · tool_args · tool_result
                · lang · stt_confidence · started_at

ScheduledCall   shop · orderId · phone · status · attempts
                · scheduledAt · outcome · outcomeNote

R2 audio        s3://{bucket}/{prefix}{room_name}.mp4
```

The egress webhook (`/webhook/livekit/egress-ready`) writes the `audioUri` back onto the corresponding `CallAttempt` row, so transcripts and audio are joinable by `room_name` for downstream training-data extraction.

---

## Production notes

- **DLT compliance**: Indian telecom regulations require DLT-registered headers on outbound calls. Your SIP trunk provider must have a 140-series DLT-registered caller ID.
- **DND window**: Default 20:00–10:00 IST (humane window, tighter than TRAI's 21:00 cutoff). The `/flow-test-livekit` endpoint bypasses DND for testing.
- **Scheduler concurrency**: `SCHEDULER_MAX_PER_TICK=1` (default) keeps single-trunk providers happy. Raising it without verifying trunk capacity caused parallel-dispatch failures in our testing; raise carefully.
- **Tool auth**: Agent → server tool calls authenticated with `LIVEKIT_TOOL_SECRET` via `X-COD-Tool-Secret` header + `crypto.timingSafeEqual` comparison. Never expose tool endpoints publicly without this.
- **Outcome atomicity**: Outcome writes use `updateMany` with a non-terminal-status guard so parallel workers can't double-write a confirmed-then-cancelled order. First terminal-tool call wins.
- **Retry**: Failed dispatches (no answer / SIP error) retry up to `MAX_ATTEMPTS` (default 3) with exponential backoff via the scheduler.
- **Recording delay**: Egress is started ~10s after dispatch so the agent has time to publish its audio track before the room-composite compositor starts. Avoids "audio missing first 5s of greeting" recordings.

---

## Adapting

- **Brand**: Set `STORE_NAME` / `STORE_CATEGORY` (single-tenant) or `STORE_BRANDING` (multi-tenant) — no code edits.
- **TTS voice**: Change `ELEVENLABS_VOICE_ID` (must be in your ElevenLabs library). For Sarvam Bulbul, edit `speaker:` in `buildTTS()` — supported v3 female voices: `ritu`, `priya`, `neha`, `pooja`, `simran`, `kavya`, `ishita`, `shreya`, `roopa`, `amelia`, `sophia`, `tanya`, `shruti`, `suhani`, `kavitha`, `rupali`.
- **Prompt tuning**: edit `prompts/<lang>-prompt.txt` (gitignored — keep it in your private repo). Use the `{{placeholder}}` slots; full list in `prompts/README.md`.
- **New product category**: add one line to `CATEGORY_MAP` in `livekit-agent.js`.
- **Call timing**: adjust `CALL_DELAY_MS` and `DND_*_HOUR` env vars.
- **Multi-store**: see "Multi-tenant" above.

---

## Adding a new profile

A profile is a directory under `profiles/<id>/` with this contract:

```
profiles/<id>/
├── profile.json    declarative descriptor (voice, tools, triggers, session)
├── agent.js        renderContext, buildSystemPrompt, buildWelcome, buildTools,
│                   turnPersistKey, TERMINAL_TOOLS
├── index.js        optional: mount(app, deps) for HTTP triggers + tool
│                   callbacks; onNoAnswer(prisma, row, reason) for post-fail housekeeping
├── prompts/        <lang>-prompt.example.txt (committed) + <lang>-prompt.txt (gitignored, tuned)
└── lib/            profile-local helpers
```

Recipe:

1. `cp -r profiles/cod-confirm profiles/my-profile` and edit the descriptor + prompts.
2. Replace agent.js's `renderContext` to map your participant attributes → prompt placeholders.
3. Replace `buildTools` with the tools the LLM should be able to call mid-conversation. Each tool POSTs to `/webhook/livekit/tool/<name>` — implement those routes in `index.js`'s `mount()`.
4. (Optional) Export `onNoAnswer({prisma, row, reason})` from `index.js` if you want to record a post-failure outcome (Shopify tag, CRM note, Slack ping).
5. Restart the `cod-confirm` (server) and `cod-confirm-agent` (LiveKit worker) services — and `cod-confirm-relay` if the profile dispatches over ConversationRelay. The profile registry auto-discovers your new `profile.json`.
6. Dispatch a call:

```bash
curl -X POST http://localhost:3104/calls/dispatch \
  -H 'Content-Type: application/json' \
  -H "X-COD-Tool-Secret: $LIVEKIT_TOOL_SECRET" \
  -d '{
    "profile": "my-profile",
    "phone": "+919876543210",
    "lang": "hi-IN",
    "payload": { "any":"keys","your":"prompt","needs":"here" }
  }'
```

`payload` is forwarded verbatim into LiveKit participant attributes; your profile's `renderContext` reads it back. `+91` dials Vobiz; anything else dials Twilio.

The contract is enforced at agent start — missing exports throw an error before the call rings out. See `profiles/appointment-remind/` for a complete second-profile example.

---

## License

Proprietary — All Rights Reserved. © Nuraveda (trading as Nuraveda Lab), solely owned by Tejas Karan Agrawal. This is **not** open source; no use, copying, modification, or distribution is permitted without prior written permission. See [LICENSE](LICENSE). For licensing inquiries, contact `help.nuraveda@gmail.com`.

---

Built by **Nuraveda Labs** as part of [Mesh Pilot](https://meshpilot.app) — AI systems for Indian e-commerce.
