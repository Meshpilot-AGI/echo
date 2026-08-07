# Retell config-as-code (cod-confirm "Priya")

The **live** Retell agent + conversation flow is the hand-tuned source of truth
(Devanagari prompts, `gpt-5.1`, custom voice, speech settings, knowledge base, the
unresolved-`{{placeholder}}` rule). This directory holds that config as versioned
JSON so it stops living only in the dashboard and can be reviewed in PRs.

## Files
- `agent.config.json` — editable agent fields (voice, speech, turn-taking, webhook,
  post-call analysis, pronunciation dictionary, response_engine binding).
- `flow.config.json` — editable conversation-flow fields (`global_prompt`, `nodes`,
  `model_choice`, `model_temperature`, `knowledge_base_ids`, `kb_config`,
  `start_node_id`/`start_speaker`).

Server-generated fields (ids, version, timestamps, `is_published`) are intentionally
excluded so each file is a clean *desired state*.

## The loop (both use the official `retell-sdk`)
```
# dashboard edits  →  pull them back into the repo, then commit
RETELL_API_KEY=… RETELL_AGENT_ID=… RETELL_CONVERSATION_FLOW_ID=… pnpm retell:capture

# repo edits  →  preview (dry-run), then push to live
… pnpm retell:apply            # DRY-RUN: prints which top-level keys differ
… pnpm retell:apply --apply    # actually PATCH agent + flow
```
`apply` is idempotent — applying an unchanged config is a no-op. Captured nodes carry
valid unique edge ids, so re-applying the snapshot does not hit Retell's
"Duplicate edge id" error that hand-built node payloads do.

## Notes
- `RETELL_CONVERSATION_FLOW_ID` is not in `.env`; the live id is
  `conversation_flow_2d02bf9e4676` (also the hardcoded fallback in `trigger-retell-call.js`).
- The flow currently includes 3 stray auto-generated nodes
  (`node-1780991965007/67268/68262`) created while editing on the dashboard canvas.
  They are captured as-is; prune them in the dashboard (or this JSON + `apply`) if unused.
- First-time creation (new brand/agent from scratch) still uses
  `src/setup-retell-conversation-flow*.mjs`; ongoing changes use capture/apply.
