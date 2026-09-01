# Security Policy

## Overview

Echo is a production AI voice-calling system that handles real customer phone calls, Shopify order data, personal phone numbers, and conversation transcripts. Security vulnerabilities here can have direct consequences for end-customers and shop operators. We take all reports seriously and respond promptly.

---

## Supported Versions

Only the latest commit on `main` is actively maintained and eligible for security patches.

| Branch / Tag    | Supported           |
| --------------- | ------------------- |
| `main` (latest) | ✅ Actively supported |
| Older commits   | ❌ No patches        |

---

## Scope

The following components and data surfaces are in scope:

- **Webhook endpoints** — Shopify `orders/create` HMAC verification, LiveKit egress webhook, tool-call secret (`X-COD-Tool-Secret`)
- **Outbound call dispatch** — `/calls/dispatch`, Retell AI trigger, Twilio ConversationRelay TwiML, LiveKit SIP trigger
- **Tool endpoints** — `confirm_order`, `cancel_order`, `request_human_agent`, `request_callback` (authenticated via `LIVEKIT_TOOL_SECRET`)
- **Relay WebSocket server** — `src/relay-server.js` at `wss://…/relay/ws`
- **Database access** — Prisma/PostgreSQL (`Session`, `ScheduledCall`, `CallAttempt`, `CallTurn`)
- **Audio/transcript storage** — Cloudflare R2 bucket access and egress URI handling
- **Secrets management** — `.env` keys for Retell, ElevenLabs, Sarvam, OpenAI, Vobiz SIP, Twilio, Shopify, R2
- **Multi-tenant isolation** — `ALLOWED_SHOPS` allowlist, per-shop HMAC secrets, `STORE_BRANDING` mapping

Out of scope: the private prompt repository, third-party providers (Retell AI, ElevenLabs, Twilio, Sarvam, OpenAI, Vobiz, Shopify), and infrastructure-level issues outside this codebase.

---

## Reporting a Vulnerability

**Please do not file public GitHub issues for security vulnerabilities.**

Report security issues privately to:

📧 **help.nuraveda@gmail.com**  
Subject line: `[SECURITY] Echo — <brief description>`

### What to include

- A clear description of the vulnerability and affected component
- Steps to reproduce or a proof-of-concept (sanitized — no real customer data)
- The potential impact (e.g., unauthenticated call dispatch, PII exposure, order mutation)
- Your suggested severity (Critical / High / Medium / Low)

### What to expect

| Stage | Timeline |
| ----- | -------- |
| Acknowledgement | Within **48 hours** |
| Initial triage & severity assessment | Within **5 business days** |
| Fix or mitigation shipped | Within **14 days** for Critical/High; best-effort for lower severity |
| Disclosure coordination | We will notify you before any public disclosure |

We do not currently offer a bug bounty program, but we will credit researchers in the changelog (with your permission).

---

## Security Design Notes

These are the primary controls in place — useful context when evaluating findings:

- **Shopify webhook authentication** — every `orders/create` event is verified with `crypto.timingSafeEqual` HMAC comparison using the per-shop secret from `SHOPIFY_WEBHOOK_SECRETS`. Shops not in `ALLOWED_SHOPS` receive HTTP 403.
- **Tool endpoint authentication** — all agent→server tool calls require the `X-COD-Tool-Secret` header, compared with `crypto.timingSafeEqual`.
- **Outcome atomicity** — `ScheduledCall` outcome writes use `updateMany` with a non-terminal-status guard to prevent double-writes (e.g., confirm then cancel on the same order).
- **DND enforcement** — outbound calls are blocked outside the configured DND window (default 20:00–10:00 IST). The `/flow-test-livekit` endpoint bypasses DND and **must never be exposed publicly in production**.
- **DPDP Act consent disclosure** — a recording consent disclosure is played at call greeting (`RECORDING_CONSENT_DISCLOSURE=on`). Disabling this in regions that legally require consent is a compliance issue.
- **SIP credential isolation** — Vobiz SIP credentials (`VOBIZ_SIP_HOST`, `VOBIZ_SIP_USERNAME`, `VOBIZ_SIP_PASSWORD`) are environment-only and never committed to the repository.
- **Retell config redaction** — `retell/agent.config.json` has the tool secret redacted in git and rehydrated at apply time via `pnpm retell:apply`. Verify this before every `pnpm retell:capture` commit.
- **No public tool endpoints** — tool callback routes must be behind a firewall or authenticated proxy and must never be openly routable on the public internet.
- **Multi-tenant isolation** — branding and webhook secrets are keyed per `shop` domain. A misconfigured `SHOPIFY_WEBHOOK_SECRETS` or `ALLOWED_SHOPS` can allow cross-shop order mutations; verify both on every new store onboard.

---

## Sensitive Data Handling

Echo processes the following categories of personal and sensitive data:

| Data type | Storage | Retention |
| --------- | ------- | --------- |
| Customer phone numbers | PostgreSQL (`ScheduledCall`) | Operator-managed |
| Conversation transcripts (text) | PostgreSQL (`CallTurn`) | Operator-managed |
| Call recordings (audio) | Cloudflare R2 (MP4/Opus) | Operator-managed |
| Shopify order details (product, amount, address) | PostgreSQL + R2 | Operator-managed |

Operators are responsible for configuring retention policies and access controls on their PostgreSQL instance and R2 bucket in accordance with DPDP Act (India) and any applicable data protection laws.

---

## Dependency & Supply Chain

- Dependencies are managed via `pnpm` with a committed lockfile (`pnpm-lock.yaml`). Audit regularly with `pnpm audit`.
- Pre-commit hooks (`.pre-commit-config.yaml`) should include secret-scanning. Never commit real API keys, SIP credentials, or webhook secrets.
- The `.env.example` file must never contain real values — it is a template only.

---

## License

Echo is part of **Mesh Pilot** — the AI marketing-operations platform by **Nuraveda Labs**.

Built for Indian e-commerce, shipping production AI voice agents that confirm COD orders, qualify leads, and handle support callbacks at scale.

**Echo is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version.**
