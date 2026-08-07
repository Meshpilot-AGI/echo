# Prompts

The agent's system prompts live here as text templates. Two layers:

| File | Committed here? | Purpose |
|---|---|---|
| `hindi-prompt.example.txt` | yes | Generic demo prompt, bundled with the public repo |
| `english-prompt.example.txt` | yes | Generic demo prompt, bundled with the public repo |
| `hindi-prompt.txt` | **no** (gitignored) | Your tuned production prompt |
| `english-prompt.txt` | **no** (gitignored) | Your tuned production prompt |

## How it works

At startup, `src/livekit-agent.js` → `loadPromptTemplate(basename)` tries
`prompts/<basename>.txt` first. If that file doesn't exist, it falls back
to `prompts/<basename>.example.txt` and logs a warning.

This lets the public repo stay runnable out-of-the-box with sensible demo
behaviour, while anyone running in production replaces the templates with
their own tuned versions — without those tunings ever touching the public
git history.

## Placeholders

Templates use `{{placeholder}}` substitution. Available fields are computed
in `buildSystemPrompt()` and include:

- `{{store_name}}`, `{{store_category}}`, `{{store_article}}`
- `{{context_block}}` — the known-context lines (product / amount / address / etc.)
- `{{order_number_phrase}}` / `{{product_phrase}}` / `{{amount_phrase}}` / `{{address_phrase}}`
- `{{call_real_suffix}}` — localised sentence tail for the "is this call real" question

Unknown placeholders pass through unchanged so typos are visible in the rendered prompt.

## Getting started (production)

```bash
cp prompts/hindi-prompt.example.txt prompts/hindi-prompt.txt
cp prompts/english-prompt.example.txt prompts/english-prompt.txt
# Now tune prompts/*.txt for your use case.
```

The production-tuned prompts for Glitch's own deployment live in the private
repo `glitch-cod-confirm-private` and are copied onto the server at deploy
time.
