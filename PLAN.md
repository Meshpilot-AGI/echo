# Generalization Plan: COD-Confirm → Mesh Pilot Voice

Pivot the engine from a single-purpose Shopify-COD caller into a multi-profile AI voice agent platform, where COD-confirm is one profile among many.

Target end state: same engine can run any of these profiles by config alone, no code branching:
- `cod-confirm` (existing) — Shopify COD order confirmation
- `lead-qualify` — inbound lead qualification (CRM webhook → call → log lead)
- `appointment-remind` — calendar event → call → confirm/reschedule
- `feedback-survey` — post-purchase NPS / CSAT call
- `support-ivr` — inbound number → triage → transfer/log

## Key abstraction: the AgentProfile

```
AgentProfile {
  id              string                      // "cod-confirm"
  name            string                      // "Priya — COD Confirmation"
  language        "hi-IN" | "en-IN" | ...
  voice           { provider, voiceId, ... }
  promptTemplate  string                      // path to prompts/<profile>/<lang>.txt
  tools           ToolDef[]                   // declarative — see below
  triggers        TriggerDef[]                // what creates a ScheduledCall for this profile
  branding        { name, category, ... }     // per-tenant override possible
  hangup          { autoMs, terminalTools[] }
}
```

Tools become declarative, not hardcoded:

```
ToolDef {
  name           "confirm_order" | "book_appointment" | ...
  description    string                       // for the LLM
  parameters     JSON schema
  handler        { type: "http", url, secret } | { type: "shopify_tag", ... }
}
```

Triggers become pluggable:

```
TriggerDef {
  type    "shopify_webhook" | "http_dispatch" | "csv_upload" | "cron" | "inbound_sip"
  config  { ... type-specific }
}
```

## Phases

### Phase 0 — Scaffold (this commit)
- [x] Write this PLAN.md
- [x] Create `profiles/` directory structure
- [x] Move existing prompts into `profiles/cod-confirm/prompts/`
- [x] Stub `profiles/cod-confirm/profile.json` describing the existing behavior declaratively
- [x] No behavior change yet — current code still runs as-is

### Phase 1 — Extract COD-specific code into profile module
- Move Shopify webhook handler → `profiles/cod-confirm/triggers/shopify-webhook.js`
- Move 4 tools (`confirm_order`/`cancel_order`/`request_human_agent`/`request_callback`) → `profiles/cod-confirm/tools/*.js`
- Move `speakableProduct`, `hindiRupees`, category map → `profiles/cod-confirm/lib/`
- Generic engine in `src/` no longer mentions "Shopify" or "COD"

### Phase 2 — Profile registry + DB schema
- Add `profile` (string) column to `ScheduledCall` (default `"cod-confirm"` for backfill)
- `src/lib/profiles.js` — loads `profiles/*/profile.json` at boot, indexes by id
- Generic dispatch endpoint: `POST /calls/dispatch` `{ profile, phone, lang, context }` → creates `ScheduledCall`
- Existing Shopify webhook keeps working (now living inside the cod-confirm profile module) and dispatches with `profile: "cod-confirm"`

### Phase 3 — Generalize livekit-agent.js
- Read `profile` from `ScheduledCall` row (passed via SIP participant attributes)
- Build prompt from `profiles/<profile>/prompts/<lang>.txt` + profile-specific context renderer
- Build tools dynamically from `profile.tools[]` — each tool's `handler` is dispatched via the http transport (already how it works today)
- Auto-hangup, AEC, VAD, interrupt rules stay engine-level (they're voice-call universals, not profile-specific)

### Phase 4 — Add a second profile to prove the abstraction
- Build `appointment-remind` profile end-to-end as the first non-COD use case
- This is the real test: if adding it requires touching `src/` rather than only `profiles/appointment-remind/`, the abstraction is leaky and we go fix it

### Phase 5 — Rename + repackage
- Repo rename: `glitch-cod-confirm` → `glitch-voice` (private + public)
- Service / systemd unit rename
- Update README to lead with the platform, with COD-confirm as the flagship profile
- Public repo gets `profiles/cod-confirm/` and `profiles/example-appointment/` as references

## Non-goals (explicitly out of scope)
- Multi-language *within* a single call (still one language per call)
- Building a UI / dashboard for profile management — JSON files are fine until there's a paying customer who needs a UI
- Replacing LiveKit, Sarvam, or ElevenLabs — engine layer stays as-is
- Inbound call handling — phase 4+ if a profile actually needs it

## Risk register
- **Schema migration**: adding `profile` to `ScheduledCall` is backwards-compatible (default value), but old in-flight calls during deploy need attention. Mitigation: deploy phase 2 during a dispatch-quiet window.
- **Prompt placeholder leak**: profiles must declare *which* placeholders their prompt uses, so the generic prompt loader can validate before dispatching a call rather than crashing mid-call.
- **Tool naming collisions**: two profiles can't both define `confirm` if they share an LLM agent name. Tools are namespaced by profile at registration time.
- **Per-profile env vars**: COD-confirm needs Shopify creds; appointment-remind needs Calendar creds. Don't pollute a single `.env` — load per-profile env via `profiles/<id>/env` (gitignored).
