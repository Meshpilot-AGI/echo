/**
 * Apply the versioned Retell config (repo → live) via the official SDK.
 *
 *   RETELL_API_KEY=... RETELL_AGENT_ID=... RETELL_CONVERSATION_FLOW_ID=... \
 *     node src/retell-apply-config.mjs            # DRY-RUN (default): shows diff, no writes
 *     node src/retell-apply-config.mjs --apply    # actually PATCH agent + flow
 *
 * Reads retell/agent.config.json + retell/flow.config.json (the desired state,
 * produced by retell-capture-config.mjs) and updates the live agent + conversation
 * flow to match. Idempotent: applying an unchanged config is a no-op diff.
 *
 * Pair: retell-capture-config.mjs (live → repo) ←→ this (repo → live). This is the
 * SDK-based successor to the hand-rolled setup-retell-*.mjs bootstrap scripts.
 */
import Retell from 'retell-sdk';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const RETELL_API_KEY = process.env.RETELL_API_KEY;
const AGENT_ID = process.env.RETELL_AGENT_ID;
const FLOW_ID = process.env.RETELL_CONVERSATION_FLOW_ID;
const APPLY = process.argv.includes('--apply');
if (!RETELL_API_KEY || !AGENT_ID || !FLOW_ID) {
  console.error('Missing RETELL_API_KEY / RETELL_AGENT_ID / RETELL_CONVERSATION_FLOW_ID');
  process.exit(1);
}

const cfgDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'retell');
const agentCfg = JSON.parse(readFileSync(join(cfgDir, 'agent.config.json'), 'utf8'));
const flowCfg = JSON.parse(readFileSync(join(cfgDir, 'flow.config.json'), 'utf8'));

// Rehydrate the redacted tool-webhook secret from env (capture stored a placeholder
// so the secret stays out of git). Without it, the diff vs live shows a phantom
// change and an --apply would push a broken (placeholder) secret to Retell.
const SECRET_PLACEHOLDER = '__LIVEKIT_TOOL_SECRET__';
const TOOL_SECRET = process.env.LIVEKIT_TOOL_SECRET || '';
function rehydrate(node) {
  if (Array.isArray(node)) { node.forEach(rehydrate); return; }
  if (node && typeof node === 'object') {
    if (node.headers?.['X-COD-Tool-Secret'] === SECRET_PLACEHOLDER) {
      node.headers['X-COD-Tool-Secret'] = TOOL_SECRET;
    }
    for (const v of Object.values(node)) rehydrate(v);
  }
}
if (JSON.stringify(flowCfg).includes(SECRET_PLACEHOLDER)) {
  if (!TOOL_SECRET) { console.error('flow config has redacted tool secret but LIVEKIT_TOOL_SECRET is unset'); process.exit(1); }
  rehydrate(flowCfg);
}

const client = new Retell({ apiKey: RETELL_API_KEY });

// Shallow diff of which top-level keys differ between desired (cfg) and live.
function changedKeys(cfg, live) {
  return Object.keys(cfg).filter(
    (k) => JSON.stringify(cfg[k]) !== JSON.stringify(live[k]),
  );
}

const liveAgent = await client.agent.retrieve(AGENT_ID);
const liveFlow = await client.conversationFlow.retrieve(FLOW_ID);
const agentDiff = changedKeys(agentCfg, liveAgent);
const flowDiff = changedKeys(flowCfg, liveFlow);

console.log(`agent: ${agentDiff.length ? 'would change ' + agentDiff.join(', ') : 'in sync'}`);
console.log(`flow:  ${flowDiff.length ? 'would change ' + flowDiff.join(', ') : 'in sync'}`);

if (!APPLY) {
  console.log('\nDRY-RUN — no writes. Re-run with --apply to push these changes.');
  process.exit(0);
}

if (agentDiff.length) {
  await client.agent.update(AGENT_ID, agentCfg);
  console.log(`✓ agent updated (${agentDiff.length} fields)`);
}
if (flowDiff.length) {
  // Captured nodes already carry valid unique edge ids, so re-applying the
  // snapshot does not hit the "Duplicate edge id" error that hand-built nodes do.
  await client.conversationFlow.update(FLOW_ID, flowCfg);
  console.log(`✓ flow updated (${flowDiff.length} fields)`);
}
if (!agentDiff.length && !flowDiff.length) console.log('Nothing to apply — already in sync.');
