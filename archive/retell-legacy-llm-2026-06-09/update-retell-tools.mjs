/**
 * One-time patch: add X-COD-Tool-Secret header to Retell custom tools.
 *
 * Retell custom tools support a `headers` object. We need this so the
 * /webhook/retell/tool/* endpoints can verify the shared secret.
 */

const RETELL_API_KEY = process.env.RETELL_API_KEY;
const RETELL_LLM_ID = process.env.RETELL_LLM_ID;
const SERVER_URL = process.env.SERVER_URL || 'https://shopify.meshpilot.app/cod-confirm';
const TOOL_SECRET = process.env.LIVEKIT_TOOL_SECRET;

if (!RETELL_API_KEY || !RETELL_LLM_ID || !TOOL_SECRET) {
  console.error('Missing RETELL_API_KEY / RETELL_LLM_ID / LIVEKIT_TOOL_SECRET');
  process.exit(1);
}

async function r(path, body, method = 'PATCH') {
  const res = await fetch(`https://api.retellai.com${path}`, {
    method,
    headers: { Authorization: `Bearer ${RETELL_API_KEY}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  if (!res.ok) { console.error(`${method} ${path} failed ${res.status}:`, json); process.exit(1); }
  return json;
}

const toolBase = `${SERVER_URL}/webhook/retell/tool`;

const general_tools = [
  {
    type: 'end_call',
    name: 'end_call',
    description: 'Hang up the call politely after the customer has responded and we have logged the outcome.',
  },
  {
    type: 'custom',
    name: 'confirm_order',
    description: 'Customer explicitly confirmed they want the order delivered. Mark the order as confirmed in our system.',
    url: `${toolBase}/confirm_order`,
    method: 'POST',
    headers: { 'X-COD-Tool-Secret': TOOL_SECRET },
    speak_during_execution: false,
    parameters: {
      type: 'object',
      properties: {
        note: { type: 'string', description: 'Optional note — any context from the conversation.' },
      },
      required: [],
    },
  },
  {
    type: 'custom',
    name: 'cancel_order',
    description: 'Customer explicitly declined / refused the order. Mark it as cancelled.',
    url: `${toolBase}/cancel_order`,
    method: 'POST',
    headers: { 'X-COD-Tool-Secret': TOOL_SECRET },
    speak_during_execution: false,
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Short reason the customer gave (e.g., "wrong size", "changed mind", "ordered by mistake").' },
      },
      required: ['reason'],
    },
  },
  {
    type: 'custom',
    name: 'request_human_agent',
    description: 'Customer needs a human — they have questions we cannot answer, or are unclear.',
    url: `${toolBase}/request_human_agent`,
    method: 'POST',
    headers: { 'X-COD-Tool-Secret': TOOL_SECRET },
    speak_during_execution: false,
    parameters: {
      type: 'object',
      properties: {
        note: { type: 'string', description: 'What the customer needs help with.' },
      },
      required: ['note'],
    },
  },
  {
    type: 'custom',
    name: 'request_callback',
    description: 'Customer is busy and asked us to call back. Schedule a retry.',
    url: `${toolBase}/request_callback`,
    method: 'POST',
    headers: { 'X-COD-Tool-Secret': TOOL_SECRET },
    speak_during_execution: false,
    parameters: {
      type: 'object',
      properties: {
        when: { type: 'string', description: 'When customer wants the call back (e.g., "in 1 hour", "evening", "tomorrow morning").' },
      },
      required: [],
    },
  },
];

async function main() {
  console.log('Patching LLM tools', RETELL_LLM_ID, '...');
  const updated = await r(`/update-retell-llm/${RETELL_LLM_ID}`, { general_tools });
  console.log('✓ LLM tools patched:', updated.llm_id);
}

main().catch(err => { console.error(err); process.exit(1); });
