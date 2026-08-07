/**
 * Run the Retell eval suite as a batch test and report per-case results.
 *
 *   RETELL_API_KEY=... RETELL_CONVERSATION_FLOW_ID=... node src/retell-eval-run.mjs
 *
 * Resolves the seeded test-case definitions (by the names in retell/eval/test-cases.json),
 * starts a batch test against the live conversation flow, polls until complete, and
 * prints pass/fail + the judge's explanation per case. Seed first with
 * src/retell-eval-seed.mjs.
 */
import Retell from 'retell-sdk';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const RETELL_API_KEY = process.env.RETELL_API_KEY;
const FLOW_ID = process.env.RETELL_CONVERSATION_FLOW_ID;
if (!RETELL_API_KEY || !FLOW_ID) {
  console.error('Missing RETELL_API_KEY / RETELL_CONVERSATION_FLOW_ID');
  process.exit(1);
}

const evalDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'retell', 'eval');
const { cases } = JSON.parse(readFileSync(join(evalDir, 'test-cases.json'), 'utf8'));
const wantNames = new Set(cases.map((c) => c.name));

const client = new Retell({ apiKey: RETELL_API_KEY });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const listing = await client.tests.listTestCaseDefinitions().catch(() => []);
const defs = (Array.isArray(listing) ? listing : (listing?.data ?? [])).filter((d) => wantNames.has(d.name));
const ids = defs.map((d) => d.test_case_definition_id || d.id);
if (!ids.length) {
  console.error('No seeded test-case definitions found — run src/retell-eval-seed.mjs first.');
  process.exit(1);
}
console.log(`starting batch test over ${ids.length} cases…`);

const batch = await client.tests.createBatchTest({
  response_engine: { type: 'conversation-flow', conversation_flow_id: FLOW_ID },
  test_case_definition_ids: ids,
});
const batchId = batch.test_case_batch_job_id;
console.log(`batch ${batchId} — polling…`);

let status = batch.status;
for (let i = 0; i < 60 && status !== 'complete'; i++) {
  await sleep(5000);
  const b = await client.tests.getBatchTest(batchId);
  status = b.status;
  process.stdout.write(`\r  ${b.pass_count}✓ ${b.fail_count}✗ ${b.error_count}⚠ / ${b.total_count}  (${status})   `);
}
console.log('\n');

const runs = await client.tests.listTestRuns(batchId).catch(() => []);
const list = Array.isArray(runs) ? runs : (runs?.data ?? []);
const idToName = new Map(defs.map((d) => [d.test_case_definition_id || d.id, d.name]));
const icon = { pass: '✓', fail: '✗', error: '⚠', in_progress: '…' };
for (const r of list) {
  const name = idToName.get(r.test_case_definition_id) || r.test_case_definition_id;
  console.log(`${icon[r.status] || '?'} ${r.status.toUpperCase().padEnd(5)} ${name}`);
  if (r.result_explanation) console.log(`     ${String(r.result_explanation).replace(/\n/g, ' ').slice(0, 240)}`);
}
const pass = list.filter((r) => r.status === 'pass').length;
console.log(`\n${pass}/${list.length} passed.  Batch: ${batchId}`);
