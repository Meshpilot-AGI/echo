# Backlog — deferred work

Items intentionally not built in the current phase, kept here so they don't fall out of memory.

## Inbound voice via Twilio

Goal: customers dial a Twilio number, reach the agent, profile chosen based on which number was called.

Why deferred: outbound is the only paying use case today (COD-confirm). Inbound expands the agent's surface area materially (caller-identification, profile-routing, separate LiveKit trunk type) and shouldn't multi-task with phase 5 cleanup.

When picked up, the work is:

1. **Public URL for Twilio webhooks.** The user's Twilio number was configured with webhook `http://172.31.16.153:5001/twilio/incoming` — that's an RFC1918 private IP and Twilio cannot reach it. Replace with a public HTTPS URL behind the existing nginx (e.g. `https://voice.glitchexecutor.com/twilio/voice/incoming`).
2. **Inbound webhook endpoint** on the engine (port 3104, behind nginx). Returns TwiML `<Dial><Sip>` pointing at a LiveKit inbound SIP trunk URI. Authenticate via Twilio's signed-request header (`X-Twilio-Signature`) — never trust unauthenticated TwiML requests.
3. **LiveKit inbound SIP trunk.** `createSipInboundTrunk` — separate resource from the outbound trunks we built. Companion `src/create-twilio-inbound-trunk.mjs` provisioning script.
4. **LiveKit dispatch rule** that fires the agent worker on inbound SIP, with the profile id passed as room metadata (or derived from the called number).
5. **Number-to-profile mapping.** `.env` (or a DB table once there's > 5 numbers): `INBOUND_NUMBER_TO_PROFILE={"+19592712955":"appointment-remind","+91XXXXX":"cod-confirm-inbound"}`.
6. **Caller identification.** Outbound calls know the customer (we initiated). Inbound calls do not — either:
   - CRM/customer-DB lookup on the caller's E.164 (best for known customers)
   - Ask the customer once at greeting ("can I have your name?") and let the profile's `renderContext` fill in dynamically (best for cold inbound)
7. **Inbound profile variants.** Some profiles need different prompts for inbound vs outbound (greeting flips from "I'm calling about X" to "thanks for calling, how can I help"). Either a second profile id (`cod-confirm-inbound`) or a `direction` flag in `participantAttributes` that the profile's `buildWelcome` branches on.

References:
- Twilio config the user shared (private IP, won't work): webhook `http://172.31.16.153:5001/twilio/incoming`, POST
- Twilio number SID for inbound routing: `PN5ca17cc73a826d4f0d2c8abebd3d871a` (`+19592712955`)
- TwiML reference: https://www.twilio.com/docs/voice/twiml/sip
- LiveKit inbound SIP: https://docs.livekit.io/sip/quickstart/#inbound

When this lands, also install the official `twilio` npm SDK
(https://github.com/twilio/twilio-node — the Node equivalent of
twilio-python you flagged). The SDK's `RequestValidator.validate()` is
the canonical way to verify the `X-Twilio-Signature` header on inbound
webhooks. Hand-rolling HMAC-SHA1 base64 over the request URL +
sorted-param body is error-prone; the SDK handles edge cases (proxy
headers, query-string vs body, repeated params). Outbound provisioning
(`src/create-twilio-trunk.mjs`) stays on raw fetch — small surface,
no need for the full SDK.

Estimated effort: 3–4 hours end-to-end, including testing.
