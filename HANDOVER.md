# Session Handover — 2026-04-19 (second update, afternoon IST)

**Read this first. Everything needed to resume is here. Do NOT place any code changes until you've run the test command below and seen current behaviour.**

---

## ⚡ FIRST THING TO DO NEXT SESSION

If the user asks for a test call, copy-paste this verbatim (swap number if needed):

```bash
curl -s "http://127.0.0.1:3104/flow-test-livekit?shop=f51039.myshopify.com&order=8973&phone=%2B919039999585" | python3 -m json.tool
```

- `shop=f51039.myshopify.com` — Urban Classics (only allowlisted shop)
- `order=8973` — real order in Urban Classics with COD tag, used repeatedly for tests
- `phone=%2B919039999585` — Man's primary test number (%2B is URL-encoded `+`)

Then watch the logs in real time:

```bash
sudo journalctl -u cod-confirm-agent.service -f --no-pager | grep --line-buffered -E "priya\]|user\]|tool\]|closing|session closed|stalled"
```

Test alternative number if the primary doesn't ring: `+918390229669` (second test phone).

---

## 🟡 Current production state — NOT FULLY WORKING

| Component | Status |
|---|---|
| `cod-confirm.service` (Express, :3104) | 🟢 active · `DISPATCH_MODE=live` |
| `cod-confirm-agent.service` (LiveKit worker) | 🟢 active, VAD 8kHz prewarmed |
| Shopify webhook HMAC | 🟢 per-shop map · Urban Classics only loaded |
| LiveKit webhooks → Express `/webhook/livekit/egress-ready` | 🟢 JWT-verified |
| Cloudflare R2 audio egress | 🟢 MP4/Opus working |
| PostgreSQL (CallTurn + CallAttempt + Session) | 🟢 transcripts persist |
| Shopify tag write (`cod-confirmed` / `cod-cancelled`) | 🟢 verified on #8973 |
| DND window | 🟢 20:00–10:05 IST (10-hour call window) |
| Freshness cutoff | 🟢 `QUEUE_ONLY_AFTER=2026-04-19T00:25:25Z`, `MAX_ORDER_AGE_HOURS=6` |
| **Vobiz SIP trunk outbound** | 🟡 **INTERMITTENT — ~50% of calls don't reach destination** |
| **Sarvam Bulbul v3 TTS (WS streaming)** | 🟡 **Occasional stalls but gives 3s turn times** |
| **Per-turn response latency** | 🟡 **3s on WS (acceptable) vs 20s+ on REST (unusable)** |
| **Priya voice quality on phone** | 🟢 Works when WS streams; Hindi pronunciation good |

**Urban Classics is technically live** (scheduler running, HMAC verified, DND respected) but real-world reliability on outbound calling is shaky. **Do not tell the user "it's production-ready" — it's in "debug mode" until Vobiz reliability is sorted.**

---

## 🔥 Known issues as of end-of-session

### Issue 1 — Vobiz SIP trunk is intermittent
On several test calls today, the SIP call was dispatched successfully to LiveKit, LiveKit created the SIP participant, but the customer's phone never rang. Webhook pattern on failed calls:

```
participant_joined (agent) + track_published (agent audio)
participant_joined (SIP) — but NO track_published from customer
30s later: participant_left (ringing timeout)
```

On successful calls, we'd see `track_published` for both participants. Difference = whether Vobiz successfully delivered to destination carrier.

**Not a code issue.** Need to either:
- Log into Vobiz dashboard and check CDR (Call Detail Records) for failed call attempts
- Ask Vobiz support why calls to `+919039999585` / `+918390229669` are intermittently not reaching phone
- Switch SIP trunk provider (Twilio Programmable Voice, Exotel, Plivo, Telnyx)

### Issue 2 — Sarvam Bulbul v3 WS TTS occasional stalls
Sarvam's WebSocket TTS endpoint sometimes sends initial audio then stops emitting frames without sending `event_type: "final"` or closing the connection. LiveKit SDK's 10s idle timeout force-closes the stream (`"TTS stream stalled after producing audio, forcing close"`). Customer hears truncated/no greeting.

Happened maybe 20% of the time today across both old and new Sarvam API keys. **Not key-related.**

**Tried and ruled out:**
- Swapping to REST endpoint via `tts.StreamAdapter` — ✗ Works reliably BUT adds 10-20s per turn. Unusable: customer says "हाँ", Priya responds 22 seconds later.
- Swapping Sarvam API key (old → new `sk_hhq4dcr5_...`) — ✗ No change in stall behaviour.

**Current config = WS streaming.** Trading occasional stalls for 3s turn times because predictable 20s lag is worse.

### Issue 3 — Framework reliability frustration
User explicitly raised [Pipecat](https://github.com/pipecat-ai/pipecat) as an alternative at end of session. Given the LiveKit Agents SDK v1.2.6 has several opaque failure modes (`startWallTime is not set when starting SegmentSynchronizerImpl.mainTask` errors, silent session.start() hangs, etc.), this is worth evaluating.

**Next session should consider prototyping Pipecat as a parallel voice worker** while keeping the Shopify/scheduler/DB/R2 pipeline unchanged. Pipecat advantages:
- Python-first, better debuggability
- Explicit pipeline model (no SDK magic)
- Native Sarvam, Groq, Cartesia, Deepgram support
- Transport-agnostic (can keep using LiveKit just for SIP transport)

Rough prototype scope: ~1-2 hours for a minimal Priya equivalent.

### Issue 4 — Phone `+918390229669` specifically has codec/carrier issue
Earlier in session: calls land, phone rings, user answers, but customer hears NO AUDIO from Priya. Same greeting reaches `+919039999585` fine. Not worth chasing — just use `+919039999585` for tests.

---

## 📋 Everything shipped today (2026-04-19)

### Morning (fixes)
- **Silero VAD at 8 kHz** (was 16kHz) — matches SIP audio sample rate natively, halves samples/window, cuts CPU load
- **`minSilenceDuration` 550 → 400 ms** — snappier end-of-turn detection

### Costing + store analysis
- Ran cost analysis on 4 end-to-end test calls (4.9 min total, ~₹11, ~$0.13)
- Per-call unit economics: **₹10.98/call** at scale
- Pulled live order data for 4 dropshipping stores (Urban, Trendsetters, Storico, Classico):

| Store | Shopify handle | Orders/30d | COD% | AOV | Fleet % |
|---|---|---|---|---|---|
| Urban Classics | `f51039.myshopify.com` | 377 | 85% | ₹2,068 | 48% |
| Trendsetters | `acmsuy-g0.myshopify.com` | 212 | 79% | ₹2,132 | 25% |
| Storico | `ys4n0u-ys.myshopify.com` | 171 | 87% | ₹2,244 | 23% |
| Classico | `52j1ga-hz.myshopify.com` | 27 | 100% | ₹1,946 | 4% |
| **Fleet** | **787 orders/30d** | **~85%** | — | |

Fleet cost: ~₹7,280/mo · RTO savings: ~₹41,766/mo · Net positive: **+₹34,486/mo**

### Critical production blocker fixed — per-shop HMAC
Before fix: ALL Shopify webhooks had been HMAC-rejected for 48 hours. Zero real orders ever queued. Test calls worked only via `/flow-test-livekit` (bypasses webhook).

Root cause: every Shopify store has its own app in Dev Dashboard with distinct Client Secret. Single `SHOPIFY_WEBHOOK_SECRET` can't validate all. Fixed with `SHOPIFY_WEBHOOK_SECRETS` JSON map pattern (`{ "shop_domain": "secret" }`), matches glitch-grow-ads-agent pattern.

### DND window tightened
Was 21:00 → 09:05 IST. User felt 9 AM is too early for someone who ordered at 9 PM. **New: 20:00 → 10:05 IST** (10-hour window).

### Freshness filters
`QUEUE_ONLY_AFTER` (hard cutoff for go-live moments) + `MAX_ORDER_AGE_HOURS` (rolling 6-hour cap). Prevents Shopify retry backlog from flooding queue after HMAC fix.

### Multi-app architecture documented
Every store has own Shopify app. Full 8-app mapping persisted in:
- `/home/support/multi-store-theme-manager/SHOPIFY_STORES_INFRA.md` (canonical source)
- `~/.claude/projects/-home-support/memory/project_glitch_cod_confirm.md` (memory pointer)

### Afternoon (the frustrating part)
Attempted to optimize per-turn latency. Many iterations:
- Prompt tightened: "ONE short sentence per response, max 12 words"
- LLM `maxTokens: 120 → 60` on gpt-4o-mini
- OpenAI prompt caching relied upon (automatic for prompts ≥1024 tokens)
- **Rotated OpenAI + Sarvam API keys** (both new, in `.env`)
- Ping-ponged between WS streaming and REST (via StreamAdapter) TTS three times trying to fix silent/stalled calls
- Cleaned stale LiveKit rooms

### Current live config (post-ping-pong)
```js
llm: new openai.LLM({ model: 'gpt-4o-mini', temperature: 0.6, maxTokens: 60 })
tts: new sarvam.TTS({ model: 'bulbul:v3', speaker: 'neha',
                     targetLanguageCode: lang, pace: 1.0, sampleRate: 8000 })
// ^ WS streaming (default), NOT wrapped in StreamAdapter
```

**Why WS not REST:** REST adds 10-20s per turn. Unusable. WS gives 3s turns but occasionally stalls. Chose reliability trade-off.

---

## 🔐 Secrets rotated today — MAY BE IN CHAT TRANSCRIPT

| Key | Where | Action if sensitive |
|---|---|---|
| Urban Classics Shopify Client Secret (`shpss_66332f...`) | `SHOPIFY_WEBHOOK_SECRETS` in `.env` | Regenerate in Partner Dashboard → Mesh Pilot X Urban → Configuration |
| Sarvam API key (`sk_hhq4dcr5_...`) | `SARVAM_API_KEY` in `.env` | Regenerate from Sarvam dashboard |
| OpenAI API key (`sk-proj-5Oib60T...`) | `OPENAI_API_KEY` in `.env` | Regenerate from OpenAI dashboard |

All in `.env` (gitignored, never committed). User is aware. Rotate anytime.

---

## 🏪 The 4 Urban-family stores (live order data)

| Store | Shopify handle | Dev Dashboard app | Auth slug |
|---|---|---|---|
| **Urban Classics** | `f51039.myshopify.com` | `Mesh Pilot X Urban` | `urban` |
| **Trendsetters** | `acmsuy-g0.myshopify.com` | `Mesh Pilot X Trendsetter` | `trendsetters` |
| **Storico** | `ys4n0u-ys.myshopify.com` | `Mesh Pilot X Storico` | `storico` |
| **Classico** | `52j1ga-hz.myshopify.com` | `Mesh Pilot X Classicoo` | `classicoo` |

**Currently only Urban Classics is in the allowlist** (`allowed_shops`). Storico and Classico webhooks will need gateway-based COD detection (they don't tag COD — current code filters by tag AND by `payment_gateway_names` includes "Cash on Delivery (COD)" so should work).

**To onboard a new store:**
1. Get its Client Secret from Partner Dashboard → [app name] → Configuration → Reveal
2. Add to `SHOPIFY_WEBHOOK_SECRETS` JSON map in `.env`:
   ```bash
   SHOPIFY_WEBHOOK_SECRETS='{"f51039.myshopify.com":"shpss_xxx","acmsuy-g0.myshopify.com":"shpss_yyy"}'
   ```
3. Add domain to shop allowlist (search `allowed_shops` in `src/server.js`)
4. Restart `cod-confirm.service`
5. Verify health endpoint shows `shopify_hmac_per_shop_count: N`

---

## 🔁 How to resume next session

### 1. First 60 seconds — verify nothing has broken overnight
```bash
# Health check
curl -s http://127.0.0.1:3104/health | python3 -m json.tool

# Services
sudo systemctl is-active cod-confirm.service cod-confirm-agent.service

# Check overnight Shopify webhook traffic (should be 0 during DND window)
sudo journalctl -u cod-confirm.service --since "today" --no-pager | grep -E "shopify-webhook|queued|stale" | tail -20
```

### 2. When the user asks for a test call — use this exact command
```bash
curl -s "http://127.0.0.1:3104/flow-test-livekit?shop=f51039.myshopify.com&order=8973&phone=%2B919039999585" | python3 -m json.tool
```

Watch logs:
```bash
sudo journalctl -u cod-confirm-agent.service -f --no-pager | grep --line-buffered -vE "inference is slower|tokio|speech_id\":|participantValue" | grep --line-buffered -E "call for|priya\]|user\]|tool\]|stalled|closing"
```

### 3. Identify which failure mode if anything goes wrong

| Symptom | Root cause | Fix |
|---|---|---|
| `HMAC mismatch` in server logs | Wrong shop's secret or new shop not in map | Add to `SHOPIFY_WEBHOOK_SECRETS` |
| `stale: too_old` or `before_go_live_cutoff` | Order's `created_at` failed freshness filter | Increase `MAX_ORDER_AGE_HOURS` or clear `QUEUE_ONLY_AFTER` temporarily |
| `[shopify] ... prepaid — skipping` | Order not COD | Expected behavior, only COD orders call |
| Phone rings but silent | Sarvam WS TTS stall | Look for `"TTS stream stalled"` in agent logs. If found, either wait and retry, or switch to REST via StreamAdapter (see below) |
| Phone doesn't ring at all | Vobiz SIP trunk issue | Check LiveKit webhook events — if only agent's `track_published` fires (no customer track), Vobiz didn't deliver. Check Vobiz CDR. |
| `call for Man Desai / #8973` appears but NO `[priya]` log within 30s | Silent hang, likely Sarvam TTS | Restart `cod-confirm-agent.service`, try again |
| `SegmentSynchronizerImpl.mainTask: startWallTime is not set` error | Known SDK bug when using StreamAdapter | Non-fatal, ignore |

### 4. If Sarvam WS stalls hard — revert to REST
Edit `src/livekit-agent.js`, find the `tts:` block, swap to:
```js
tts: new tts.StreamAdapter(
  new sarvam.TTS({
    model: 'bulbul:v3', speaker: 'neha', targetLanguageCode: lang,
    pace: 1.0, sampleRate: 8000, streaming: false,
  }),
  new tokenize.basic.SentenceTokenizer(),
),
```
And add `tokenize` and `tts` to the `@livekit/agents` import (already imported right now). Then `sudo systemctl restart cod-confirm-agent.service`. **Warning: this gives reliable calls but 10-20s per turn. User won't like it.**

### 5. If user wants to evaluate Pipecat
See "Issue 3" above. Repo: https://github.com/pipecat-ai/pipecat. User brought this up today. Plan:
1. Create a new Python worker alongside existing Node.js agent: `src/pipecat-agent/priya.py`
2. Reuse the Express server's Shopify webhook handler + scheduler + DB + R2 egress — only swap the voice pipeline
3. Keep LiveKit as SIP transport (Pipecat has a LiveKit transport)
4. Use same Sarvam STT/TTS but via Pipecat's explicit pipeline (better observability)
5. A/B test by routing some calls to Pipecat worker via different agent name

---

## 📁 Files that changed today

| File | Change |
|---|---|
| `src/livekit-agent.js` | VAD 8kHz, minSilenceDuration 400ms, maxTokens 60, prompt "ONE sentence", ping-ponged TTS WS/REST — currently on **WS direct** |
| `src/server.js` | `SHOPIFY_WEBHOOK_SECRETS` JSON map + `resolveShopifySecret()`, `isOrderFresh()` filter, per-shop HMAC log |
| `.env` | Added `SHOPIFY_WEBHOOK_SECRETS` (Urban only), `DND_START_HOUR=20`, `DND_END_HOUR=10`, `QUEUE_ONLY_AFTER`, `MAX_ORDER_AGE_HOURS=6`. Rotated `SARVAM_API_KEY`, `OPENAI_API_KEY`. |
| `.env.example` | Documented all new env vars |
| `HANDOVER.md` | This file (twice rewritten today) |
| `/home/support/multi-store-theme-manager/SHOPIFY_STORES_INFRA.md` | Added Dev Dashboard app names alongside slugs |
| `~/.claude/.../memory/project_glitch_cod_confirm.md` | 8-store app mapping appended |

All git commits on `main` branch; last commit `59d0286` pushed. TTS revert to WS direct (current live code) is **uncommitted** — check `git status`.

---

## 📚 Important context for next session

- **Moat is data, not prompts.** Every call records audio to R2 + per-turn CallTurn rows in Postgres. This corpus is the long-term asset for Sarvam fine-tuning. Preserve recording fidelity above all else.
- **User's style:** Technical founder/CTO. Direct comms. Expects honest tech assessment, not cheerleading. Will push back if numbers don't match reality.
- **Do NOT claim "this is fixed" until a live call demonstrates it.** User tested ~10 times today; patience is thin on voice issues.
- **Time-of-day matters:** DND window 20:00–10:05 IST. Outside that, even `/flow-test-livekit` needs manual trigger.
- **Proprietary license — All Rights Reserved.** © Nuraveda (trading as Nuraveda Lab), solely owned by Tejas Karan Agrawal. Not open source; no third-party use/copy/redistribution without written permission. Vendored third-party SDKs keep their own original licenses.

---

## 🎯 Priority order for next session

1. **Verify phone call still works** — one test call, check timings. If it's still 20s+ lag, the WS-vs-REST decision may need revisiting.
2. **Investigate Vobiz reliability** — if calls still intermittently don't reach phone, this is the biggest blocker. Ask user to check Vobiz dashboard CDR, or we switch trunk provider.
3. **Evaluate Pipecat prototype** — user's ask. ~1-2 hrs. Python branch, parallel worker, same backend.
4. **Onboard remaining 3 stores** — Trendsetters/Storico/Classico. Each needs its Client Secret + allowlist entry.
5. **Delete legacy files** — `src/setup-retell-agent.mjs`, `src/setup-bolna-agent.mjs`, `src/update-retell-agent.mjs` (dead code).
6. **Add regression tests** for the 6 closed issues (#7–#12).

---

## Contact

Commercial licensing / enterprise deployment: **support@meshpilot.app**

---

**TL;DR for next Claude:**
- Production state: Urban Classics live, tech works ~70% of calls
- Biggest unknown: Vobiz reliability (external to our code)
- Voice latency: 3s per turn on WS TTS, 20s on REST — stay on WS
- User is evaluating Pipecat. Respect that option.
- Exact test command: see top of this doc. Don't ask user how to place a test — the command is right there.
