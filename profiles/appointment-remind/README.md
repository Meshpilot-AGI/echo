# appointment-remind profile

Maya calls customers ~24h before a booked appointment, confirms attendance, captures reschedules or cancellations, and escalates the few cases that need a human (insurance, clinical specifics, billing).

Built as the second profile on the Mesh Pilot Voice engine — the deliberate test of whether the phase-0–3 generalization actually removed all COD-confirm leaks. Verdict: zero `src/` changes were needed to ship this profile.

## What this profile owns

- `profile.json` — descriptor (voice, STT/LLM, 4 tools, http_dispatch trigger, session params)
- `agent.js` — `renderContext` + `buildSystemPrompt` + `buildWelcome` + `buildTools` + `turnPersistKey` + `TERMINAL_TOOLS`
- `index.js` — `mount(app, deps)` that registers `/webhook/livekit/tool/{confirm_appointment, reschedule_appointment, cancel_appointment, request_human_agent}` handlers (PoC: log + best-effort CallTurn write; swap in real Calendar/CRM writes when a customer ships)
- `prompts/*.example.txt` — generic demo prompts in Hindi + English; copy to `*.txt` and tune for production (gitignored same as cod-confirm)

## How to dispatch a call

```bash
curl -sS -X POST http://localhost:3104/calls/dispatch \
  -H 'Content-Type: application/json' \
  -H "X-COD-Tool-Secret: $LIVEKIT_TOOL_SECRET" \
  -d '{
    "profile": "appointment-remind",
    "phone": "+919XXXXXXXXX",
    "lang": "hi-IN",
    "idempotencyKey": "appt-A12345",
    "payload": {
      "appointment_id":   "A12345",
      "customer_name":    "Aman",
      "provider_name":    "Sunshine Dental",
      "appointment_date": "kal",
      "appointment_time": "gyaarah baje",
      "service_name":     "cleaning",
      "location":         "Andheri West"
    }
  }'
```

Returned `id` is the `ScheduledCall` row. The scheduler polls every 30s, places the SIP call via Vobiz, and the agent worker loads `profiles/appointment-remind/agent.js` based on the `profile` participant attribute.

⚠ Today the scheduler still reads payload fields with COD-shaped names (`customer_name`, `delivery_city`, etc.) when building `triggerLivekitCall`'s `order` arg. The appointment payload's `customer_name` will reach the agent because both profiles use that field; but `appointment_date` / `appointment_time` / `service_name` / `location` will not, because the scheduler doesn't forward them. Phase 5 will generalize the scheduler→agent payload to pass `payload` through verbatim under a participant attribute. Until then, this profile is the abstraction proof, not a fully-shippable use case.

## What's intentionally not wired

- Real Google Calendar / internal-scheduler integration on the tool handlers
- A real reschedule loop (today: capture preferred slot string, return ok)
- Reminder-window scheduling (today: caller decides `scheduledAt`)

All three plug in here without engine changes. Phase 4's job was to prove the abstraction; production wiring follows a paying customer.
