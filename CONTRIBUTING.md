# Contributing to Echo

## Quick Overview

**Echo is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version.**

We welcome contributions! This document explains how to contribute effectively while keeping the codebase secure, maintainable, and compliant with AGPL-3.0.

---

## License & Copyleft Notice

This repository is licensed under the **GNU Affero General Public License, Version 3 (AGPL-3.0)**. See [`LICENSE`](LICENSE) for the full text.

Key implications:

- **You may use, modify, and distribute Echo** — including in commercial products — as long as you comply with AGPL-3.0
- **Network use counts as distribution** — if you run a modified version of Echo as a service (e.g., SaaS), you must make the source code of your modifications available to all users who interact with it over a network
- **Derivative works must be AGPL-3.0** — if you build on top of Echo (e.g., new profiles, engine modifications), your changes must also be released under AGPL-3.0
- **Prompts are part of the work** — tuned prompts in `prompts/<lang>-prompt.txt` are derivative works and must be AGPL-3.0 if distributed or used in a network service

For questions about AGPL compliance or commercial licensing alternatives, contact: **help.nuraveda@gmail.com**

---

## How to Contribute

### 1. Fork and Clone

```bash
git clone https://github.com/your-username/echo.git
cd echo
git remote add upstream https://github.com/Meshpilot-AGI/echo.git
```

### 2. Create a Branch

```bash
git checkout -b feature/your-feature-name
```

Use descriptive branch names:
- `feature/` for new features or profiles
- `fix/` for bug fixes
- `docs/` for documentation improvements
- `refactor/` for code improvements without behavior changes

### 3. Make Your Changes

Follow the [Code Style & Conventions](#code-style--conventions) below. Ensure your changes:
- Are focused and atomic (one logical change per PR)
- Include tests if applicable (see `test/` directory)
- Update documentation if behavior changes
- Do not break existing functionality

### 4. Test Locally

```bash
# Install dependencies
pnpm install

# Run linter (if configured)
pnpm lint

# Run tests
pnpm test

# Test your profile or feature end-to-end
DISPATCH_MODE=dry_run node src/server.js
```

### 5. Commit with Clear Messages

```bash
git add .
git commit -m "feat: add appointment-remind profile with Maya persona

- Implements profile.json, agent.js, index.js for appointment reminders
- Adds prompts/english-prompt.txt with appointment confirmation flow
- Includes test cases in test/appointment-remind.test.js

Closes #123"
```

Follow [Conventional Commits](https://www.conventionalcommits.org/) where possible:
- `feat:` new features
- `fix:` bug fixes
- `docs:` documentation
- `style:` formatting, missing semi-colons, etc.
- `refactor:` code changes without behavior changes
- `test:` adding or updating tests
- `chore:` maintenance tasks, dependencies, config

### 6. Push and Open a Pull Request

```bash
git push origin feature/your-feature-name
```

Then open a PR on GitHub against `Meshpilot-AGI/echo:main`.

In your PR description, include:
- **What** this PR changes and why
- **How** to test it (steps, curl commands, expected behavior)
- **Related issues** (e.g., `Closes #123`)
- **Screenshots or logs** if applicable

---

## What We're Looking For

### ✅ High-Value Contributions

- **New profiles** — additional use cases following the profile contract (`profiles/README.md`)
- **Bug fixes** — especially for production issues (Retell runtime, Twilio relay, LiveKit legacy)
- **Performance improvements** — latency reductions, memory optimizations, faster cold starts
- **Documentation** — clearer README, profile examples, deployment guides, troubleshooting
- **Tests** — unit tests, integration tests, eval suite expansions (`retell/eval/`)
- **DevEx improvements** — better scripts, tooling, local development workflows
- **Security hardening** — secret scanning, input validation, safer defaults

### ⚠️ Contributions That Need Discussion First

- **Breaking changes** — API changes, env var renames, profile contract modifications
- **Major refactors** — engine architecture changes, telephony stack swaps
- **New dependencies** — especially heavy or controversial packages
- **AI model changes** — switching LLMs, STT, TTS providers (may affect latency/cost)

Open an Issue or Discussion before starting work on these.

### ❌ Unlikely to Be Accepted

- Cosmetic changes without functional improvements (e.g., renaming variables, reformatting)
- Features that conflict with AGPL-3.0 (e.g., proprietary add-ons, SaaS lock-in)
- Changes that break multi-tenant isolation or DND compliance
- Vendor-specific optimizations that reduce portability (unless well-justified)

---

## Reporting Bugs

Before opening an issue:

1. Search existing Issues to confirm it hasn't been reported
2. Verify you're on the latest commit of `main`
3. Reproduce the issue in a clean environment (no production secrets)

When filing, include:

- **Environment**: Node.js version, OS, runtime (Retell vs LiveKit), relevant env vars (redacted)
- **Steps to reproduce**: Minimal, reproducible commands or curl snippets
- **Expected vs actual behavior**
- **Logs or error traces** (sanitized — no API keys, phone numbers, or order IDs)

Label your issue appropriately (e.g., `bug`, `enhancement`, `question`). Maintainers will respond and triage.

---

## Security Reports

**Do not file public Issues for security vulnerabilities.** See [`SECURITY.md`](SECURITY.md) for the private reporting process, expected timelines, and scope.

---

## Code Style & Conventions

- **Language**: JavaScript (Node.js 20+), no TypeScript in this repo
- **Formatting**: 2-space indentation, no semicolons required, trailing commas in multi-line objects
- **Imports**: Use `require()` for CommonJS consistency with existing code
- **Env vars**: Follow the naming in `.env.example`; never hardcode secrets
- **Prompts**: Keep `prompts/<lang>-prompt.txt` in your private fork if proprietary; only commit `.example.txt` templates to public repos
- **Config-as-code**: Retell agent/flow JSON (`retell/*.config.json`) must have secrets redacted before commit
- **Tests**: Use Jest or Node's built-in `test` module; place tests in `test/` directory

Run `pnpm lint` (if configured) before committing to catch style issues.

---

## Architecture Notes

Echo is a **profile-agnostic voice engine** with self-contained use cases under `profiles/<id>/`:
profiles/
├── cod-confirm/ # India COD confirmation (Retell + Vobiz SIP — production)
├── concierge/ # International (+1/US) delivery/lead/support (Twilio ConversationRelay)
├── appointment-remind/ # Appointment reminders (reference 2nd profile)
└── README.md # Profile contract (profile.json, agent.js, index.js, prompts/)

Key design principles:

- **Engine is profile-agnostic**: Adding a new use case requires only a new profile directory — zero engine changes
- **Two telephony stacks**: Retell + Vobiz SIP for `+91` (India); Twilio ConversationRelay for `+1` (international)
- **Data moat**: Every call produces paired (audio, transcript, outcome) assets in R2 + PostgreSQL for future fine-tuning
- **Multi-tenant**: Per-shop allowlist (`ALLOWED_SHOPS`), HMAC secrets (`SHOPIFY_WEBHOOK_SECRETS`), and branding (`STORE_BRANDING`)

See the [README](README.md) and `profiles/README.md` for full details.

---

## AGPL-3.0 Compliance Checklist

Before merging, ensure your contribution complies:

- [ ] No proprietary code or closed-source dependencies introduced
- [ ] All new files include the AGPL-3.0 license header (see `LICENSE` for template)
- [ ] No vendor lock-in that would prevent users from running their own instance
- [ ] Network-use implications are documented (e.g., if adding SaaS-specific features)
- [ ] Third-party dependencies are AGPL-compatible (check licenses with `pnpm licenses ls`)

---

## Questions?

For general questions or discussion, open a GitHub Issue labeled `question` or start a Discussion.

For AGPL compliance or commercial licensing inquiries:

📧 **help.nuraveda@gmail.com**

---

## Acknowledgements

Echo is part of **Mesh Pilot** — the AI marketing-operations platform by **Nuraveda Labs**.

Built for Indian e-commerce, shipping production AI voice agents that confirm COD orders, qualify leads, and handle support callbacks at scale.

**Echo is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version.**
