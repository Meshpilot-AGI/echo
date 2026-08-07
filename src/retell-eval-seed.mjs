/**
 * Seed Retell test-case definitions from versioned personas (config-as-code).
 *
 *   RETELL_API_KEY=... RETELL_CONVERSATION_FLOW_ID=... node src/retell-eval-seed.mjs
 *
 * Reads retell/eval/test-cases.json and creates (or updates, by name) one Retell
 * TestCaseDefinition per persona, bound to our conversation flow. A simulated
 * caller (user_prompt) talks to the agent; the 4 order tools are MOCKED so tests
 * never hit our live server. Run the suite with src/retell-eval-run.mjs.
 *
 * PREREQUISITE: the metric names referenced in test-cases.json must exist as Retell
 * Custom Metrics (define them in the dashboard — rubrics in retell/eval/README.md).
 *
 * Idempotent: re-running updates existing definitions by name instead of duplicating.
 */
import Retell from 'retell-sdk';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const RETELL_API_KEY = process.env.RETELL_API_KEY;
const FLOW_ID = process.env.RETELL_CONVERSATION_FLOW_ID;
const SIM_MODEL = process.env.RETELL_EVAL_SIM_MODEL || 'gpt-5.1'; // simulated-caller LLM
if (!RETELL_API_KEY || !FLOW_ID) {
  console.error('Missing RETELL_API_KEY / RETELL_CONVERSATION_FLOW_ID');
  process.exit(1);
}

const evalDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'retell', 'eval');
const { cases } = JSON.parse(readFileSync(join(evalDir, 'test-cases.json'), 'utf8'));

// Mock all 4 order tools: any input → success, so a test exercises the agent's
// decision path without POSTing to our real cod-confirm server.
const TOOL_MOCKS = ['confirm_order', 'cancel_order', 'request_human_agent', 'request_callback'].map(
  (tool_name) => ({ tool_name, input_match_rule: { type: 'any' }, output: '{"success": true}' }),
);

const responseEngine = { type: 'conversation-flow', conversation_flow_id: FLOW_ID };

function toDefinition(c) {
  return {
    name: c.name,
    metrics: c.metrics,
    response_engine: responseEngine,
    user_prompt: c.user_prompt,
    dynamic_variables: c.dynamic_variables,
    llm_model: SIM_MODEL,
    tool_mocks: TOOL_MOCKS,
  };
}

const client = new Retell({ apiKey: RETELL_API_KEY });

// Build name → existing id map for idempotent upsert.
const listing = await client.tests.listTestCaseDefinitions().catch(() => []);
const existing = Array.isArray(listing) ? listing : (listing?.data ?? []);
const byName = new Map(existing.map((d) => [d.name, d.test_case_definition_id || d.id]));

const ids = [];
for (const c of cases) {
  const body = toDefinition(c);
  const id = byName.get(c.name);
  try {
    const res = id
      ? await client.tests.updateTestCaseDefinition(id, body)
      : await client.tests.createTestCaseDefinition(body);
    const newId = res.test_case_definition_id || res.id || id;
    ids.push(newId);
    console.log(`${id ? 'updated' : 'created'}  ${c.name}  (${newId})`);
  } catch (err) {
    console.error(`FAILED   ${c.name}: ${err?.error?.message || err?.message || err}`);
  }
}
console.log(`\n${ids.length}/${cases.length} test-case definitions seeded.`);
console.log('Run the suite:  node src/retell-eval-run.mjs');
