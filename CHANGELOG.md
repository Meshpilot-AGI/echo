# Changelog — `glitch-cod-confirm`

Auto-regenerated from `git log` by `/home/support/bin/changelog-regen`,
called before every push by `/home/support/bin/git-sync-all` (cron `*/15 * * * *`).

**Purpose:** traceability. If a push broke something, scan dates + short SHAs
here; then `git show <sha>` to see the diff, `git revert <sha>` to undo.

**Format:** UTC dates, newest first. Each entry: `time — subject (sha) — N files`.
Body text (if present) shown as indented sub-bullets.

---

## 2026-04-27

- **07:45 UTC** — auto-sync: 2026-04-27 07:45 UTC (`c9874fa`) — 1 file
        M	src/livekit-agent.js
- **04:11 UTC** — fix(#13): close CallAttempt rows on scheduler failure paths (`91a9702`) — 2 files
    Previously markScheduledCallOutcome() (tool-driven outcomes) closed the
    latest open CallAttempt by stamping endedAt + disposition. But the
    scheduler's handleFailure() — invoked by both pre-call dispatch errors
    (triggerLivekitCall threw) and the stuck-dispatch sweep — only updated
    ScheduledCall, leaving CallAttempt.endedAt = null and
    CallAttempt.disposition = null forever. Result: orphan half-rows that
    broke turnCount, audio-recording joins, and any "currently active"
    operational dashboard.
    Issue #13 evidence on production showed 7 orphan attempts dating back
    to the parallel-dispatch storm of 2026-04-22.

## 2026-04-25

- **20:35 UTC** — docs: rewrite README to match shipped architecture (`36527cb`) — 1 file
    Original README had drifted significantly from current state. Rewrite
    covers what actually runs in production today.
    Updated:
    - TTS: ElevenLabs (Samisha, eleven_turbo_v2_5) is now production default;
      Sarvam Bulbul stays wired as 10-second outage fallback. Was documented
      the other way around.
    - LLM token cap: 60 (was 120 in docs) — enforces "≤12 word sentences"
      prompt rule mechanically.
    - DND default: 20:00–10:00 IST (humane window, tighter than TRAI's
      21:00 cutoff). Was 21:00–09:00 in docs.
- **04:58 UTC** — revert: parallelize cold-start — placeholder Agent races to self-exit (`085bbf7`) — 1 file
    Real call #2907 (SUNNY, Storico) showed the parallelize approach has
    an unfixable race. The flow:
      session.start({ agent: placeholderAgent })  // empty tools, trivial instr
      await waitForParticipant
      session.updateAgent(realAgent)
      await session.updateActivityTask?.result    // attempted fix in 77168f3
      session.say(welcome)
    But the placeholder Agent (no tools, trivial instructions) caused
    AgentActivity mainTask to self-exit IMMEDIATELY upon activation —
    "scheduling paused and no more speech tasks to wait" → "AgentActivity
- **04:47 UTC** — voice: await agent-swap task before queuing welcome (fix dead-air race) (`77168f3`) — 1 file
    Real call #2907 (SUNNY, Storico) exposed a race condition introduced
    by the parallelize cold-start refactor. The flow:
      session.start({ agent: placeholderAgent })  // starts placeholder activity
      await waitForParticipant
      session.updateAgent(realAgent)              // async swap, returns void
      session.say(welcome)                        // queues on... which activity?
    session.updateAgent() does NOT return a promise. It kicks off an
    internal Task stored at session.updateActivityTask. If session.say()
    runs while that swap is in progress, the speech can land on the
    placeholder's activity (being torn down) and never play.
- **04:30 UTC** — auto-sync: 2026-04-25 04:30 UTC (`ac2709e`) — 2 files
        A	scripts/find-yesterday-cod.mjs
- **04:27 UTC** — voice: non-interruptible welcome to survive DTMF / button presses (`556a91d`) — 1 file
    Real call #9022 (Kirti M, Urban Classics) showed a hard failure mode:
    customer pressed a phone button mid-greeting, the DTMF tone crossed
    our 600ms/3-word VAD threshold, speech was interrupted at second 7,
    STT extracted no transcribable text from the DTMF audio, the LLM had
    no user input to respond to, AgentActivity mainTask exited, and the
    customer sat through 11 seconds of dead air before hanging up.
    Pattern in the log:
      speech interrupted by audio activity
      [priya] <full greeting text logged>     ← spoken text (interrupted)
      mainTask: scheduling paused and no more speech tasks to wait

## 2026-04-24

- **03:01 UTC** — multi-tenant: onboard Storico store alongside Urban Classics (`1a54afb`) — 3 files
    Storico (ys4n0u-ys.myshopify.com) is the second tenant on the agent.
    The system was already multi-tenant-aware at the architecture level
    (per-shop Session row for Shopify Admin API, per-shop webhook secrets,
    dynamic store_name via participant attributes) — this commit fills in
    the remaining config + code so Priya knows which brand to say per call.
    Changes:
      * lib/shops.js: new getShopBranding(shop) — reads STORE_BRANDING JSON
        env var, falls back to STORE_NAME / STORE_CATEGORY for unmapped
        shops. Lookups are case-insensitive; invalid JSON logs a warning
        and falls back gracefully. Caps at ~5 tenants before we should

## 2026-04-22

- **06:38 UTC** — perf: parallelize STT/TTS cold-start with SIP ring + speak amounts in words (`4108829`) — 1 file
    Two fixes uncovered during today's live dispatch:
    1. Cold-start dead air (50% of real calls)
       Previously: await waitForParticipant (2-8s SIP ring) → then
       serially run session.start() (5-12s for Sarvam STT + ElevenLabs TTS
       + OpenAI LLM WS upgrades). Customers heard 10-20s of silence post-
       pickup, concluded spam, hung up.
       Now: session.start() fires immediately after ctx.connect(), running
       in parallel with waitForParticipant. A placeholder Agent is used
       for the warmup; the real agent (with per-call instructions + tools)
       is hot-swapped via session.updateAgent() once participant attrs
- **06:30 UTC** — auto-sync: 2026-04-22 06:30 UTC (`1a84c67`) — 3 files
        M	package.json
        M	pnpm-lock.yaml
- **06:07 UTC** — perf: warm Sarvam/ElevenLabs/OpenAI TLS during prewarm (`7b2869b`) — 1 file
    Per-call session.start() was serialising cold TLS handshakes to
    api.sarvam.ai (STT), api.elevenlabs.io (TTS), and api.openai.com (LLM).
    From this VPS each handshake is 3-6s, and session.start() doesn't
    return until all three WS connections are up. Result: 10-12s of dead
    air between customer-picks-up and Priya-greets, sometimes 20+s at
    peak. Real customers #8999 and #9000 hung up during that window.
    Fire a fire-and-forget HEAD to each upstream during prewarm — long
    enough to complete TLS negotiation and prime Node's tls.createSecureContext
    session cache + DNS resolver. Subsequent WS upgrades from that child
    process reuse the cached TLS session (fast resumption).
- **05:41 UTC** — voice: raise interruption threshold to stop backchannel-barging (`8475974`) — 1 file
    Real call #8998 (Dilshan Singh) exposed a severe UX regression: Indian
    customers backchannel heavily — 'हाँ हाँ', 'हाँ जी', 'accha', 'ji ji' —
    while the agent is still talking. That's politeness, not an
    interruption. The prior minInterruptionWords=2 threshold was crossed by
    2-word 'हाँ जी' and shredded Priya's sentences into 1-word fragments —
    the product line 'आपने #8998' restarted 6 times over 20 seconds before
    completing. The order still confirmed (tool fired), but the customer
    experience was chaotic and sounded laggy.
    Two gates, must BOTH cross:
      minInterruptionWords:    2 → 3   (real objections are 3+ words:

## 2026-04-21

- **06:15 UTC** — auto-sync: 2026-04-21 06:15 UTC (`9e14a49`) — 2 files
        M	src/livekit-agent.js
- **05:50 UTC** — tts: normalize SKU to speakable category before it reaches the prompt (`1a091fc`) — 1 file
    Real-call transcript #8985 had Priya reading the full SKU verbatim:
    "Maybach Frame Karan Aujla Edition Luxury Sunglass With Original Packing"
    That's 13 English words in a Hindi sentence — TTS mispronounces the
    brand words ("Maybach", "Luxury") and prosody shreds across the run.
    The existing prompt rule telling the LLM to say "sunglasses" instead
    was getting ignored because the path of least resistance is to read
    whatever `{{product_phrase}}` contains.
    Fix at build time, not at LLM time: `speakableProduct(raw, lang)` maps
    the SKU through a category keyword table and returns a single spoken
    noun ("sunglasses" / "चश्मे"). Brands never reach TTS, so mispronouncing
- **05:43 UTC** — tts: make ElevenLabs the production default, Sarvam the fallback (`9dc13f4`) — 2 files
    After the Hindi A/B:
    - ElevenLabs (Samisha, eleven_turbo_v2_5) won on subjective naturalness
      and had comparable-or-better TTFT on both sandbox and real SIP calls.
    - Enterprise-tier ElevenLabs access removes the 4–8× per-char cost that
      originally made Sarvam the cheaper default.
    Changes:
    - buildTTS() default: 'elevenlabs' (was 'sarvam'). Sarvam path stays
      fully wired — flipping TTS_PROVIDER=sarvam in .env is a 10-second
      recovery for ElevenLabs outages or voice-access disruptions.
    - .env.example reorders TTS config up-front and documents that Sarvam
- **03:23 UTC** — gitignore: isolate nested private prompts repo (`b9e6b10`) — 1 file
    prompts/ is now the working tree of a nested private git repo
    (glitch-cod-confirm-private) that version-controls the tuned hindi +
    english prompts. Its own .gitignore is owned by that private repo and
    must not be tracked by this public one.
    Mirrors the exact pattern used for glitch-grow-ai-social-media-agent's
    brand/ dir. See memory/leak_remediation_2026_04_21.md for why.
    Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
- **02:05 UTC** — refactor: externalize prompts to prompts/*.txt (two-repo split) (`bd16b6e`) — 5 files
    Prompts are the real IP — every iteration tunes them against real call
    data, and once we have enough signal we'll fine-tune our own models on
    top. Leaving the fully-tuned prompts baked into a public repo makes that
    future moat harder to protect. This change draws the line at today.
    Pattern:
    - prompts/<lang>-prompt.example.txt — committed here, generic demo.
    - prompts/<lang>-prompt.txt          — gitignored; lives in the private
                                           repo glitch-cod-confirm-private
                                           and is deployed to production.
    buildSystemPrompt() reads prompts/<lang>-prompt.txt first, falls back
- **02:00 UTC** — auto-sync: 2026-04-21 02:00 UTC (`2051dcc`) — 1 file
        A	prompts/hindi-prompt.txt
- **01:54 UTC** — safety: mandatory re-confirmation before cancel_order + STT-skepticism rule (`8e97978`) — 1 file
    Hardens two revenue-loss paths surfaced during the Sarvam vs ElevenLabs A/B:
    1. Cancel flow now requires an explicit yes/no re-confirmation turn before
       cancel_order fires. One mistranscribed word ("ही" vs "नहीं") is no longer
       enough to cancel a legitimate order.
    2. New STT-skepticism rule: if the customer has already positively confirmed
       product+amount AND address, and then says something contradicting, the
       LLM must ask a clarifying question instead of flipping to cancel.
    Both changes applied to Hindi+English prompts. Mirrors the failure mode
    observed in sandbox call #3 where STT transcribed "मैंने ही किया था" as
    "मैं नहीं किया था" and the LLM correctly followed the (wrong) transcript

## 2026-04-20

- **22:53 UTC** — Update docs after public repo renames (`41213a2`) — 2 files
- **20:49 UTC** — Polish branding for Glitch Executor Labs public positioning (`4fc978e`) — 1 file
- **16:45 UTC** — auto-sync: 2026-04-20 16:45 UTC (`cded8d3`) — 4 files
        M	package.json
        M	pnpm-lock.yaml
        M	src/livekit-agent.js
- **16:30 UTC** — auto-sync: 2026-04-20 16:30 UTC (`3606ac7`) — 3 files
        M	package.json
        M	pnpm-lock.yaml

## 2026-04-19

- **18:15 UTC** — auto-sync: 2026-04-19 18:15 UTC (`7df840a`) — 2 files
        M	src/livekit-agent.js
- **17:08 UTC** — docs: detailed session handover with exact test commands (`93d5e3a`) — 1 file
    The previous handover was too high-level — next session didn't know
    how to fire a test call. This version has:
    - Copy-paste-ready test command at the TOP of the doc
    - Known failure modes + symptom → root cause → fix table
    - All API keys rotated today flagged as potentially in chat transcript
    - Honest status: Urban Classics live but Vobiz/Sarvam WS reliability
      issues remain. Not "production-ready" yet.
    - User's Pipecat evaluation ask captured as next-session priority
    - Current TTS config revert to WS streaming (REST gave 20s turn times)
    Also includes the uncommitted TTS revert (REST StreamAdapter → WS
- **13:15 UTC** — auto-sync: 2026-04-19 13:15 UTC (`39b6df1`) — 2 files
        M	src/livekit-agent.js
- **12:45 UTC** — auto-sync: 2026-04-19 12:45 UTC (`a9c234e`) — 2 files
        M	src/livekit-agent.js
- **12:13 UTC** — perf: shorter responses to cut per-turn latency (`5a595fb`) — 1 file
    - maxTokens 120 → 60 on gpt-4o-mini mechanically enforces brevity
    - Prompt updated: ONE sentence per response, no chaining with
      "और"/"फिर"/"और" (Hindi) or "and"/"then"/"so" (English)
    - OpenAI prompt caching is automatic for prompts ≥1024 tokens;
      our ~1800-token system prompt caches after 2nd call in 5 min,
      saving ~300ms/call on LLM first-token latency
    Root cause of perceived slowness on +919039999585 test: Priya was
    generating 2-3 long sentences per turn (~10s spoken audio each),
    making total turn time feel like 13s when actual LLM+TTS latency
    was only ~3s. Brevity fixes the UX.
- **10:45 UTC** — auto-sync: 2026-04-19 10:45 UTC (`5a0d42d`) — 2 files
        M	src/livekit-agent.js
- **00:51 UTC** — docs: refresh handover for 2026-04-19 session (`ac67cb4`) — 1 file
    Full state snapshot: Urban Classics live, per-shop HMAC map,
    DND tightened to 20:00–10:05 IST, freshness filters active,
    4-store cost model + expansion plan documented.
    Resume instructions included — open this file first next session.
- **00:26 UTC** — feat: freshness filters + clearer HMAC startup log (`b811e9d`) — 2 files
    - QUEUE_ONLY_AFTER (ISO timestamp): hard cutoff for going-live moments.
      Orders created on/before this moment are 200-ack'd but not queued.
      Prevents Shopify's 48h retry backlog from flooding the call queue
      when HMAC/webhook issues get fixed.
    - MAX_ORDER_AGE_HOURS (default 6): rolling freshness check. Orders
      older than this are skipped. Catches post-outage recovery scenarios
      where calling 2-day-old orders would be bad UX.
    - Both filters AND together. Failed webhooks still return 200 so
      Shopify stops retrying; logged as "stale: <reason>".
    - Startup HMAC log now distinguishes per-shop map / fallback / none —
- **00:23 UTC** — chore: document humane DND window defaults (10:00–20:00 IST) (`fac0d11`) — 1 file
    TRAI allows 09:00–21:00 but waking someone at 9am after they ordered
    at 9pm the night before is a poor customer experience. Tightening
    to 10:00–20:00 gives a 10-hour call window with buffer on both ends.
    No code change — dnd.js was already env-var driven; just documenting
    the recommended values in .env.example.
- **00:17 UTC** — feat: per-shop webhook secret map for multi-store deployments (`1450d42`) — 2 files
    Every Shopify store has its own app in the Dev Dashboard with its own
    Client Secret, so webhook HMACs are signed with different keys per
    store. The old single SHOPIFY_WEBHOOK_SECRET could only validate one
    store at a time — all other stores' webhooks were rejected as HMAC
    mismatch (observed on Urban Classics in production).
    - Add SHOPIFY_WEBHOOK_SECRETS env var (JSON map keyed by myshopify
      domain) matching the glitch-grow-ads-agent pattern
    - Resolve secret per-request using X-Shopify-Shop-Domain header
    - SHOPIFY_WEBHOOK_SECRET retained as fallback for single-store setups
    - Health endpoint now surfaces per-shop count + fallback status

## 2026-04-18

- **23:27 UTC** — perf: VAD at 8kHz matches SIP audio natively, halves CPU load (`9a0a43d`) — 1 file
    Root cause of "inference is slower than realtime" warnings at call start:
    Silero VAD defaulted to 16kHz while SIP audio arrives at 8kHz. The plugin
    was resampling every frame 8→16kHz before inference, then processing twice
    as many samples per window. On our 2-CPU VPS, this collided with Sarvam
    STT/TTS WebSocket startup + LLM initialization → VAD fell behind realtime.
    Fix: load VAD with sampleRate: 8000. Silero's ONNX model natively supports
    both 8k and 16k — no quality trade-off, just skips the resample step and
    halves samples-per-window.
    Also: minSilenceDuration 550ms → 400ms for snappier turn-end detection on
    SIP latency (default tuned for studio mic, not phone lines).
- **23:22 UTC** — docs: add session handover for 2026-04-18 (`09f34e5`) — 1 file
    Snapshot of production state, everything shipped this session, open
    items, known issues, env var diff, and resume instructions. Start
    here when picking up the project again.
- **00:27 UTC** — chore: update license contact to support@glitchexecutor.com (`64fc8fc`) — 2 files
    Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
- **00:25 UTC** — chore: relicense from MIT to BSL 1.1 (`91bd8d0`) — 2 files
    License converts to Apache 2.0 on 2030-04-18. Production use permitted
    except for offering as a competing hosted/embedded product.
    Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
- **00:08 UTC** — docs: add MIT LICENSE file (`9a7ce30`) — 1 file
- **00:05 UTC** — docs: overhaul README to reflect shipped pipeline (`3807471`) — 1 file
    - Architecture diagram updated to show full flow: webhook → scheduler
      → LiveKit room → SIP call + audio egress → per-turn transcript →
      Shopify tag write
    - Data pipeline section: CallTurn (PostgreSQL) + R2 audio recording,
      moat rationale, DPDP consent disclosure
    - New env vars documented: LIVEKIT_TOOL_SECRET, RECORDING_BACKEND,
      R2_*, RECORDING_CONSENT_DISCLOSURE, DISPATCH_MODE, STORE_NAME,
      STORE_CATEGORY
    - LiveKit webhook setup instructions added
    - Key design decisions expanded: AEC warmup tuning (3000→500ms),

## 2026-04-17

- **23:50 UTC** — perf: cut barge-in lag and response latency (`a4ebc94`) — 1 file
    - aecWarmupDuration 3000→500ms: SDK disables all interruptions during
      AEC warmup; 3s was blocking customer barge-in for the entire first
      3 seconds of every Priya turn. 500ms stabilises echo canceller on SIP
      while making interruptions responsive from the start.
    - maxTokens: 120 on gpt-4o-mini: Priya only speaks 1-2 short Hindi
      sentences per turn (~60-90 tokens). Uncapped generation was adding
      unnecessary LLM latency after every interruption.
    - minInterruptionWords: 2: prevents single-syllable breath / "hmm"
      sounds from cutting Priya off; real barge-in still triggers cleanly.
- **23:43 UTC** — fix: switch room composite egress to MP4+Opus to resolve codec error (`168ae8d`) — 1 file
    OGG caused "no supported codec is compatible with all outputs" on every
    call — room composite's rendering pipeline needs an explicit codec.
    MP4 with AudioCodec.OPUS + audioOnly: true is the canonical working
    combination. File extension changed from .ogg → .mp4.
- **23:26 UTC** — fix: call confirm_order in same turn as customer's final confirmation (`b260194`) — 1 file
    Previous behaviour: LLM said the confirmation phrase, then waited for
    user to speak again, THEN called the tool — causing a race where if
    the customer hung up before the next turn, the tool never fired.
    Fix: prompt now instructs the model to call confirm_order in the same
    LLM response as the customer's "हाँ/sahi hai/yes" — tool fires before
    the speech, in the same turn, no second user input required.
    Also tightened tool description to reinforce same-turn behaviour.
- **23:17 UTC** — fix: force tool call before farewell to prevent missed Shopify writes (`76844c8`) — 1 file
    Hindi + English prompts: added MANDATORY rule that no goodbye/farewell
    may be spoken until a tool (confirm_order / cancel_order / etc.) has
    been called. Step 3 instruction strengthened from "फिर call करो" to
    "उसी turn में तुरंत call करो — tool call के बिना goodbye मत बोलो."
    Root cause: on first live call (#8973) Priya said the confirmation
    phrase then jumped straight to farewell without calling confirm_order,
    leaving the Shopify order untagged. This rule closes that gap.
- **23:04 UTC** — fix: capture assistant transcript text + delay egress start (`a217500`) — 2 files
    - Use `item.textContent` (SDK getter) instead of `item.content` (raw
      array) when persisting assistant turns — fixes blank Priya rows in
      CallTurn table, confirmed against v1.2.6 chat_context.js source.
    - Delay audio egress start by 10 s so the agent has time to join the
      room and publish its audio track before startRoomCompositeEgress is
      called — fixes "no supported codec is compatible with all outputs"
      error that occurred on empty rooms at dispatch time.
    Validated on first live smoke call: 13-turn Hindi conversation,
    order #8973 confirmed by customer, egress fix pending next call.
- **20:45 UTC** — auto-sync: 2026-04-17 20:45 UTC (`32a711a`) — 2 files
        M	src/server.js
- **20:15 UTC** — auto-sync: 2026-04-17 20:15 UTC (`cd8e195`) — 2 files
        M	src/server.js
- **19:30 UTC** — Add Cloudflare R2 backend for recording egress ($0 egress for training) (`2128807`) — 3 files
    Adds RECORDING_BACKEND=r2 alongside existing gcp and s3 options. R2 is
    S3-compatible, so reuses LiveKit's S3Upload class with two extra fields
    the generic s3 path didn't set: endpoint=https://<account>.r2.cloudflare
    storage.com and forcePathStyle=true. Region is hardcoded to "auto" (R2
    convention).
    Why default to R2: training pulls the full dataset to a GPU box once per
    experiment. At 100K calls/mo (~24 GB/mo accumulated), egress at GCS/S3
    rates is ~$3/training-run; R2 is $0. Storage itself is ~$0.40/mo at that
    scale (under free tier for the first couple of years).
    Config: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY.
- **02:45 UTC** — auto-sync: 2026-04-17 02:45 UTC (`c259920`) — 2 files
        M	src/livekit-agent.js
- **02:26 UTC** — chore: add gitleaks pre-commit hook (`a596673`) — 1 file
    Blocks commits containing API keys, tokens, or other secrets.
    Install locally: pre-commit install
    Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>

## 2026-04-16

- **22:28 UTC** — Add data-moat foundation: per-turn transcripts, audio egress, consent (`776be3d`) — 2 files
    Building the proprietary dataset for later training. Schema + endpoint +
    agent changes were captured by auto-sync as dd5c7ee; this commit adds the
    manual-migration artifact that applies the new columns against an already-
    running Postgres.
    Feature set (across this commit and dd5c7ee):
    Schema (prisma/schema.prisma)
    - CallAttempt gains audioUri, audioFormat, audioDurationMs,
      audioSampleRate, lang, consentGiven, turnCount — pointers + metadata
      so the training exporter can join (audio, transcript, outcome).
    - New CallTurn model: one row per utterance. Fields: turnIndex (monotonic),
- **21:45 UTC** — auto-sync: 2026-04-16 21:45 UTC (`dd5c7ee`) — 6 files
        M	.env.example
        M	prisma/schema.prisma
        M	src/livekit-agent.js
        M	src/server.js
        M	src/trigger-livekit-call.js
- **20:45 UTC** — auto-sync: 2026-04-16 20:45 UTC (`c0f2d80`) — 4 files
        M	MILESTONES.md
        M	README.md
        M	src/setup-bolna-agent.mjs
- **20:33 UTC** — Genericize store brand, scrub client references for public-repo readiness (`b8953af`) — 7 files
    Completes the genericization pass started in 98afada (auto-sync picked up
    the agent/trigger-call/retell-setup changes before a human commit landed).
    Prompts, welcomes, and agent names now read from STORE_NAME / STORE_CATEGORY
    env vars (single-tenant default) or from order.storeName / order.storeCategory
    participant attributes (multi-tenant path, resolved per-shop by the caller of
    triggerLivekitCall). Default STORE_NAME="our store", STORE_CATEGORY="online
    store" so the agent degrades gracefully if the env is unset.
    Touched in 98afada:
    - src/livekit-agent.js      — store_name/store_category threaded through
                                  Hindi + English prompts, welcome, attrs. New
- **20:30 UTC** — auto-sync: 2026-04-16 20:30 UTC (`98afada`) — 4 files
        M	src/livekit-agent.js
        M	src/setup-retell-agent.mjs
        M	src/trigger-livekit-call.js
- **20:22 UTC** — Fix 6 P1/P2 reliability issues in tool pipeline (`78121c4`) — 3 files
    Addresses issues #7–#12 discovered on post-launch review of the
    Shopify → LiveKit → Shopify writeback path.
    - #9 (P1): COD gateway detection now normalizes non-alphanumerics,
      so "Cash on Delivery", "cash-on-delivery", "cashondelivery" and "COD"
      all classify as COD instead of being silently skipped as prepaid.
    - #8 (P1): /webhook/livekit/tool/* now requires X-COD-Tool-Secret
      matched against LIVEKIT_TOOL_SECRET via timingSafeEqual. Fails
      closed if the secret is not configured. Agent sends the header.
    - #7 (P1): Tool handler returns 400 on bad input and 500 on real
      backend failures, not 200+{ok:false}. Agent requires both res.ok
- **05:41 UTC** — Add DISPATCH_MODE=dry_run|live gate for safe beta testing (`7f9d907`) — 1 file
    Default mode remains 'live' (so missing env doesn't surprise-disable
    production). For beta, set DISPATCH_MODE=dry_run.
    In dry_run:
      - Webhook handler runs full validation (HMAC, allowlist, COD detection,
        phone normalization, DND adjustment, idempotency)
      - ScheduledCall rows are enqueued exactly as in production
      - Scheduler picks up due rows on its 30s tick
      - Instead of calling triggerLivekitCall, the scheduler logs the full
        payload and writes status='done', outcome='dry_run' + a CallAttempt
        with disposition='dry_run'
- **05:15 UTC** — auto-sync: 2026-04-16 05:15 UTC (`324be1f`) — 3 files
        M	src/lib/scheduler.js
        M	src/server.js
- **04:35 UTC** — Production-ready beta: DB queue, DND, phone normalization, retry, allowlist (`75c0fc6`) — 4 files
    Full P0+P1 production hardening push. Replaces the in-memory setTimeout
    Map (which lost every pending call on restart) with a durable Postgres-
    backed queue and 30s poll scheduler.
    SERVER (src/server.js) — rewritten:
      - Webhook handler now enqueues ScheduledCall rows idempotently via
        @@unique([shop, orderId]) — Shopify retries can't create duplicates
      - HMAC-missing rejected (was silently accepted before)
      - ALLOWED_SHOPS gate — webhook from non-beta stores returns 200 silently
        (doesn't leak which shops we serve) and increments reject counter
      - Phone normalized on ingress via normalizePhone() — invalid phones
- **04:30 UTC** — auto-sync: 2026-04-16 04:30 UTC (`af78cca`) — 7 files
        M	prisma/schema.prisma
        A	src/lib/dnd.js
        A	src/lib/fetch.js
        A	src/lib/phone.js
        A	src/lib/scheduler.js
        ... (+1 more)
- **03:03 UTC** — Add comprehensive README for public repo SEO (`3d542c2`) — 1 file
    - Full architecture diagram and stack breakdown
    - Setup instructions with .env template
    - Design decisions (8kHz TTS, Devanagari prompts, platform comparison)
    - Shopify integration guide with tag reference
    - Adaptation guide for other stores
    Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
- **03:01 UTC** — Fix 3 correctness bugs in webhook and COD detection paths (`5c64074`) — 1 file
    P1: Webhook HMAC bypass — reject requests missing X-Shopify-Hmac-Sha256
        when SHOPIFY_WEBHOOK_SECRET is configured. Previously a request with
        no header at all was silently accepted, allowing unauthenticated
        callers to trigger fake COD calls.
    P1: COD detection TypeError — payment_gateway_names is an array in real
        Shopify payloads, but .toLowerCase() was called on it directly.
        Now joins array to string before matching.
    P2: Tag writeback silent success — updateOrderTag() returned early without
        throwing when no Shopify session existed. Callers reported ok:true to
        the voice agent while the tag was never written. Now throws so callers
- **02:56 UTC** — Voice AI agent for Indian COD order confirmation on Shopify stores (`31855e9`) — 15 files
    Stack:
    - LiveKit Agents JS + Sarvam Bulbul v3 TTS (voice=neha, sampleRate=8000)
    - Sarvam Saaras v3 STT (hi-IN, Hinglish code-switch)
    - GPT-4o-mini as the brain, bilingual system prompt (warm agent "Priya")
    - Vobiz SIP trunk for outbound PSTN calls via LiveKit
    - Express webhook server for Shopify orders/create integration
    - Prisma + PostgreSQL for session/order state
    Features:
    - Bilingual (hi-IN default, en-IN via ?lang=en-IN)
    - 5 function calls: confirm_order, cancel_order, request_human_agent, request_callback, end_call
