/**
 * Capture the LIVE Retell agent + conversation-flow config into versioned JSON.
 *
 *   RETELL_API_KEY=... RETELL_AGENT_ID=... RETELL_CONVERSATION_FLOW_ID=... \
 *     node src/retell-capture-config.mjs
 *
 * Writes (overwrites):
 *   retell/agent.config.json   — editable agent fields (voice, speech, webhook…)
 *   retell/flow.config.json    — editable flow fields (global_prompt, nodes, model…)
 *
 * WHY: the live agent/flow is the canonical, hand-tuned source of truth (Devanagari
 * prompts, model_choice, speech settings, the unresolved-placeholder rule, KB).
 * The old bootstrap scripts drifted to stale Latin-Hinglish. This pulls the live
 * state back into the repo so config is version-controlled. Pair with
 * retell-apply-config.mjs (repo → live). READ-ONLY against Retell.
 */
import Retell from 'retell-sdk';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const RETELL_API_KEY = process.env.RETELL_API_KEY;
const AGENT_ID = process.env.RETELL_AGENT_ID;
const FLOW_ID = process.env.RETELL_CONVERSATION_FLOW_ID;
if (!RETELL_API_KEY || !AGENT_ID || !FLOW_ID) {
  console.error('Missing RETELL_API_KEY / RETELL_AGENT_ID / RETELL_CONVERSATION_FLOW_ID');
  process.exit(1);
}

// Editable agent fields (everything update-agent accepts) — server-generated
// fields (agent_id, version, last_modification_timestamp, is_published, channel,
// base_version) are intentionally excluded so the JSON is a clean desired-state.
const AGENT_FIELDS = [
  'agent_name', 'response_engine',
  'voice_id', 'voice_model', 'voice_temperature', 'voice_speed',
  'enable_dynamic_voice_speed', 'volume', 'fallback_voice_ids',
  'enable_backchannel', 'backchannel_frequency', 'backchannel_words',
  'responsiveness', 'enable_dynamic_responsiveness', 'interruption_sensitivity',
  'normalize_for_speech', 'boosted_keywords', 'pronunciation_dictionary',
  'language', 'stt_mode', 'denoising_mode', 'vocab_specialization',
  'reminder_trigger_ms', 'reminder_max_count', 'ambient_sound', 'ambient_sound_volume',
  'voicemail_option', 'max_call_duration_ms', 'end_call_after_silence_ms',
  'begin_message_delay_ms', 'ring_duration_ms', 'allow_user_dtmf', 'user_dtmf_options',
  'webhook_url', 'webhook_events', 'handbook_config', 'pii_config',
  'post_call_analysis_data', 'post_call_analysis_model',
  'analysis_successful_prompt',
];

// Editable conversation-flow fields.
const FLOW_FIELDS = [
  'global_prompt', 'nodes', 'start_node_id', 'start_speaker', 'tools',
  'model_choice', 'model_temperature', 'tool_call_strict_mode',
  'knowledge_base_ids', 'kb_config', 'default_dynamic_variables',
  'begin_tag_display_position', 'mcps',
];

function pick(obj, fields) {
  const out = {};
  for (const k of fields) if (obj[k] !== undefined && obj[k] !== null) out[k] = obj[k];
  return out;
}

// SECRET REDACTION: the flow's tool webhooks authenticate to our server with the
// X-COD-Tool-Secret header (value = LIVEKIT_TOOL_SECRET). That MUST NOT land in git.
// Replace any such header value with a placeholder; retell-apply-config.mjs rehydrates
// it from env before pushing. Add other secret-bearing headers here if introduced.
const SECRET_HEADER = 'X-COD-Tool-Secret';
const SECRET_PLACEHOLDER = '__LIVEKIT_TOOL_SECRET__';
function redactSecrets(node) {
  if (Array.isArray(node)) { node.forEach(redactSecrets); return; }
  if (node && typeof node === 'object') {
    if (node.headers && typeof node.headers === 'object' && SECRET_HEADER in node.headers) {
      node.headers[SECRET_HEADER] = SECRET_PLACEHOLDER;
    }
    for (const v of Object.values(node)) redactSecrets(v);
  }
}

const client = new Retell({ apiKey: RETELL_API_KEY });

const agent = await client.agent.retrieve(AGENT_ID);
const flow = await client.conversationFlow.retrieve(FLOW_ID);

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'retell');
mkdirSync(outDir, { recursive: true });

const agentCfg = pick(agent, AGENT_FIELDS);
const flowCfg = pick(flow, FLOW_FIELDS);
redactSecrets(flowCfg); // strip X-COD-Tool-Secret → placeholder before writing to disk

// Stable, pretty, UTF-8 (Devanagari preserved). Trailing newline for clean diffs.
const dump = (o) => JSON.stringify(o, null, 2) + '\n';
writeFileSync(join(outDir, 'agent.config.json'), dump(agentCfg));
writeFileSync(join(outDir, 'flow.config.json'), dump(flowCfg));

console.log(`captured agent (${Object.keys(agentCfg).length} fields) → retell/agent.config.json`);
console.log(`captured flow  (${Object.keys(flowCfg).length} fields, ${flowCfg.nodes?.length ?? 0} nodes) → retell/flow.config.json`);
console.log(`  voice: ${agentCfg.voice_id} / ${agentCfg.voice_model}  | model: ${flowCfg.model_choice?.model}  | KB: ${(flowCfg.knowledge_base_ids||[]).length}`);
