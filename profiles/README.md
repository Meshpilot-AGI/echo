# profiles/

Each subdirectory is one **agent profile** — a self-contained use case the engine can run.

A profile is the answer to: *"who is this voice agent, what does it call about, what tools does it have, and what counts as a successful outcome?"*

```
profiles/
├── cod-confirm/                 ← flagship: Shopify COD order confirmation
│   ├── profile.json             ← declarative descriptor (voice, tools, triggers, outcomes)
│   ├── prompts/                 ← per-language prompt templates (gitignored real, .example committed)
│   ├── tools/                   ← tool handler implementations (Shopify GraphQL writes, etc.)
│   ├── triggers/                ← what creates a ScheduledCall (Shopify webhook handler lives here)
│   └── lib/                     ← profile-local helpers (speakableProduct, hindiRupees, category map)
└── README.md (this file)
```

## Adding a profile

1. Copy `cod-confirm/` as a starting point: `cp -r profiles/cod-confirm profiles/<your-id>`
2. Edit `profile.json` — id, name, languages, tools, triggers, outcomes
3. Implement tool handlers in `tools/` — each handler is a small function called by the generic `/webhook/livekit/tool/<name>` route
4. Implement triggers in `triggers/` — most profiles will use the generic `http_dispatch` trigger and not need anything custom
5. Drop language prompts in `prompts/<lang>.txt`
6. Restart the server — the profile registry auto-discovers `profiles/*/profile.json` at boot

## What stays in the engine, not the profile

The voice-call engine in `src/` owns: LiveKit session lifecycle, SIP dispatch, STT/TTS/LLM wiring, turn detection, VAD, AEC warmup, interruption rules, recording egress, auto-hangup, transcript persistence, scheduler, DND. None of this is profile-specific.

The profile owns: who the agent is, what it says, which tools it has, what triggers a call, and how to interpret the outcome.
