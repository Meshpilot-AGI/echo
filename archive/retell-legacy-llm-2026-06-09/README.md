# Archived: legacy single-prompt Retell LLM scripts (2026-06-09)

These three scripts targeted the **old single-prompt Retell LLM** (`RETELL_LLM_ID`,
`create-retell-llm`), which was superseded by the **Conversation-Flow** architecture.
They are dead code (HANDOVER.md already flagged them for deletion) and are kept here
only for historical reference.

- `setup-retell-agent.mjs`   — created the Retell LLM + agent (single-prompt era)
- `update-retell-agent.mjs`  — patched that LLM + agent in place
- `update-retell-tools.mjs`  — added the X-COD-Tool-Secret header to the LLM's tools

**Current canonical path (conversation-flow + SDK):**
- `src/retell-capture-config.mjs` — live → `retell/*.config.json`
- `src/retell-apply-config.mjs`   — `retell/*.config.json` → live
- `src/setup-retell-conversation-flow*.mjs` — first-time bootstrap (create from scratch)
