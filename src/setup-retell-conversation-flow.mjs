/**
 * Create a Retell Conversation Flow for COD-confirm "Priya".
 *
 * NOTE (2026-06-09): this is the FIRST-TIME bootstrap (create-from-scratch). For
 * ONGOING changes to the live flow, use the SDK-based config-as-code pair instead:
 *   retell/flow.config.json  ←→  src/retell-{capture,apply}-config.mjs
 * The live flow (Devanagari, gpt-5.1) is canonical; this script's inline prompts are
 * the original English/Hinglish bootstrap and are intentionally not kept in sync.
 *
 * Flow:
 *   greeting → confirm_details → intent_parse (subagent with 4 tools)
 *     ├─ confirm_order   → close_confirmed → end
 *     ├─ cancel_order    → close_cancelled → end
 *     ├─ request_human   → close_agent     → end
 *     └─ request_callback → close_callback → end
 *
 * Run:
 *   RETELL_API_KEY=... SERVER_URL=... LIVEKIT_TOOL_SECRET=... \
 *     node src/setup-retell-conversation-flow.mjs
 *
 * Prints conversation_flow_id — copy to .env as RETELL_CONVERSATION_FLOW_ID.
 */

const RETELL_API_KEY = process.env.RETELL_API_KEY;
const SERVER_URL = process.env.SERVER_URL || process.env.COD_CONFIRM_WEBHOOK_BASE || 'https://shopify.meshpilot.app/cod-confirm';
const TOOL_SECRET = process.env.LIVEKIT_TOOL_SECRET;
const STORE_NAME = process.env.STORE_NAME || 'our store';

if (!RETELL_API_KEY || !TOOL_SECRET) {
  console.error('Missing RETELL_API_KEY or LIVEKIT_TOOL_SECRET');
  process.exit(1);
}

async function r(path, body, method = 'POST') {
  const res = await fetch(`https://api.retellai.com${path}`, {
    method,
    headers: { Authorization: `Bearer ${RETELL_API_KEY}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) {
    console.error(`${method} ${path} failed ${res.status}:`, JSON.stringify(json, null, 2).slice(0, 2000));
    process.exit(1);
  }
  return json;
}

const webhookBase = `${SERVER_URL}/webhook/retell/tool`.replace(/\/+$/, '');

const TOOLS = [
  {
    tool_id: 'tool_confirm_order',
    type: 'custom',
    name: 'confirm_order',
    description: 'Customer explicitly confirmed they want the order delivered. Mark the order as confirmed in our system.',
    url: `${webhookBase}/confirm_order`,
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
    tool_id: 'tool_cancel_order',
    type: 'custom',
    name: 'cancel_order',
    description: 'Customer explicitly declined / refused the order. Mark it as cancelled.',
    url: `${webhookBase}/cancel_order`,
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
    tool_id: 'tool_request_human_agent',
    type: 'custom',
    name: 'request_human_agent',
    description: 'Customer needs a human — they have questions we cannot answer, or are unclear.',
    url: `${webhookBase}/request_human_agent`,
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
    tool_id: 'tool_request_callback',
    type: 'custom',
    name: 'request_callback',
    description: 'Customer is busy and asked us to call back. Schedule a retry.',
    url: `${webhookBase}/request_callback`,
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

function nodePrompt(text) {
  return { type: 'prompt', text };
}

function alwaysEdge(to) {
  return {
    id: `edge_always_${to}`,
    destination_node_id: to,
    transition_condition: { type: 'prompt', prompt: 'Always' },
  };
}

function promptEdge(id, to, prompt) {
  return {
    id,
    destination_node_id: to,
    transition_condition: { type: 'prompt', prompt },
  };
}

const NODES = [
  {
    id: 'greeting',
    type: 'conversation',
    instruction: nodePrompt(
      `## Identity\nYou are Priya, a friendly customer-care representative from ${STORE_NAME}.\n\n` +
      `## Task\nGreet the customer warmly in Hinglish.\n` +
      `Say exactly: "Namaste {{customer_name}} ji, main Priya bol rahi hoon {{store_name}} se."\n\n` +
      `## Style\n- Speak naturally with warmth.\n- Do not add extra information.\n- Transition immediately after the greeting.`
    ),
    always_edge: alwaysEdge('confirm_details'),
  },
  {
    id: 'confirm_details',
    type: 'conversation',
    instruction: nodePrompt(
      `## Identity\nYou are Priya from {{store_name}}.\n\n` +
      `## Task\nState the order details briefly and ask for confirmation in one sentence:\n` +
      `"Aapne {{product_name}} order kiya hai, total ₹{{total_amount}} — delivery {{delivery_area}}, {{delivery_city}} pe hogi, COD pe. Confirm kar doon?"\n\n` +
      `## Style\n- One sentence only.\n- Moderate pace.\n- Wait for the customer to respond before moving on.\n` +
      `- Do NOT read out any order number or long order ID — identify the order by product, amount and address only.`
    ),
    edges: [
      promptEdge('edge_to_intent', 'intent_parse', 'Customer has responded to the confirmation question'),
    ],
  },
  {
    id: 'intent_parse',
    type: 'subagent',
    instruction: nodePrompt(
      `## Identity\nYou are Priya from {{store_name}}. You just asked the customer to confirm their COD order.\n\n` +
      `## Task\nListen to the customer's response and call exactly ONE tool. Do NOT have a full conversation here — just call the right tool.\n\n` +
      `- If customer says YES ("haan", "yes", "confirm", "theek hai", "kar do", "bhej do", "sahi hai", "ji"):\n` +
      `  → call tool \`confirm_order\`\n` +
      `- If customer says NO or wants to cancel ("nahi", "cancel", "mujhe nahi chahiye", "mana", "galti se"):\n` +
      `  → ask one polite probe: "Koi baat nahi, kya reason thi?"\n` +
      `  → then call tool \`cancel_order\` with the reason\n` +
      `- If customer asks something you cannot answer (refund timing, size exchange, etc.) or asks for a human:\n` +
      `  → call tool \`request_human_agent\`\n` +
      `- If customer is busy or asks to call back:\n` +
      `  → call tool \`request_callback\`\n` +
      `- If customer asks a simple objection ("kitne paise?", "kab aayega?", "return policy?"):\n` +
      `  → answer very briefly, then re-ask "Confirm kar doon?" and stay in this node\n\n` +
      `## Style\n- Call the tool immediately when intent is clear.\n- If intent is unclear after two attempts, call \`request_human_agent\`.\n- Do not ramble.`
    ),
    tool_ids: ['tool_confirm_order', 'tool_cancel_order', 'tool_request_human_agent', 'tool_request_callback'],
    edges: [
      promptEdge('edge_confirmed', 'close_confirmed', 'The confirm_order tool was called successfully'),
      promptEdge('edge_cancelled', 'close_cancelled', 'The cancel_order tool was called successfully'),
      promptEdge('edge_agent', 'close_agent', 'The request_human_agent tool was called successfully'),
      promptEdge('edge_callback', 'close_callback', 'The request_callback tool was called successfully'),
    ],
  },
  {
    id: 'close_confirmed',
    type: 'conversation',
    instruction: nodePrompt(
      `## Identity\nYou are Priya from {{store_name}}.\n\n` +
      `## Task\nClose the call warmly. Say: "Aapka order confirm ho gaya hai. Dhanyawaad, aapka din shubh ho!"\n\n` +
      `## Style\n- One sentence only.\n- Warm and polite.`
    ),
    always_edge: alwaysEdge('end'),
  },
  {
    id: 'close_cancelled',
    type: 'conversation',
    instruction: nodePrompt(
      `## Identity\nYou are Priya from {{store_name}}.\n\n` +
      `## Task\nClose the call warmly. Say: "Koi baat nahi, order cancel kar diya gaya hai. Dhanyawaad!"\n\n` +
      `## Style\n- One sentence only.\n- Warm and polite.`
    ),
    always_edge: alwaysEdge('end'),
  },
  {
    id: 'close_agent',
    type: 'conversation',
    instruction: nodePrompt(
      `## Identity\nYou are Priya from {{store_name}}.\n\n` +
      `## Task\nClose the call warmly. Say: "Main aapko human agent se connect kar rahi hoon. Ek minute rukiye."\n\n` +
      `## Style\n- One sentence only.\n- Warm and polite.`
    ),
    always_edge: alwaysEdge('end'),
  },
  {
    id: 'close_callback',
    type: 'conversation',
    instruction: nodePrompt(
      `## Identity\nYou are Priya from {{store_name}}.\n\n` +
      `## Task\nClose the call warmly. Say: "Bilkul, main aapko call back kar lungi. Dhanyawaad!"\n\n` +
      `## Style\n- One sentence only.\n- Warm and polite.`
    ),
    always_edge: alwaysEdge('end'),
  },
  {
    id: 'end',
    type: 'end',
  },
];

async function main() {
  console.log('Creating Retell Conversation Flow...');
  const flow = await r('/create-conversation-flow', {
    name: `COD Confirm — ${STORE_NAME} (Conversation Flow)`,
    // Rich, conversational global prompt (Retell prompt-engineering guide:
    // Identity / Style / Knowledge / Reactions / Guardrails) so the agent feels
    // like a real human call, not an IVR. A Knowledge Base (delivery, returns,
    // "is this call real", COD, cancel/change) is attached to the LIVE flow via
    // knowledge_base_ids so Priya answers questions instead of escalating.
    global_prompt:
      `# Identity\n` +
      `You are Priya — a warm, friendly customer-care representative at ${STORE_NAME}. You are a real person on a quick phone call, NOT a robot or an IVR menu. You speak natural Indian Hinglish the way people actually talk.\n\n` +
      `# Why you are calling\n` +
      `The customer just placed a Cash-on-Delivery (COD) order. You are calling to quickly confirm it before it ships. Keep it light and fast — under a minute.\n\n` +
      `# Style — sound like a real human\n` +
      `- Short, natural sentences; one line, then pause and listen.\n` +
      `- Everyday Hinglish + contractions: haan, achha, theek hai, ek second, bilkul, ji, koi baat nahi.\n` +
      `- Vary your wording every time — never repeat the same sentence. Acknowledge what they say before moving on.\n` +
      `- Match their language and energy. Warm, respectful, never pushy or salesy. One question at a time.\n\n` +
      `# Answer their questions (use your knowledge)\n` +
      `You have a knowledge base (delivery time, returns/exchange, how COD works, is this call genuine, changing/cancelling the order, product quality). If they ask anything, answer briefly and naturally from it, then steer back to confirming. Do NOT escalate for things you can answer.\n\n` +
      `# Guardrails\n` +
      `- NEVER ask for OTP, payment, card, UPI PIN, or bank details. Payment is only cash at delivery.\n` +
      `- Call the correct tool the moment intent is clear. A short garbled positive reply with no clear "nahi/cancel" means yes.`,
    start_node_id: 'greeting',
    start_speaker: 'agent',
    // gpt-5.1: most natural/nuanced conversation with reliable tool-calling
    // (Retell-recommended for richer flows). Swap to 'claude-sonnet-4-6' for an
    // even warmer multilingual feel, or 'gpt-4.1' for lowest latency/cost.
    model_choice: { type: 'cascading', model: 'gpt-5.1' },
    model_temperature: 0.4,  // low temp = focused, brief turns (gpt-5.1 otherwise over-talks)
    nodes: NODES,
    tools: TOOLS,
  });

  console.log('\n=====');
  console.log('RETELL_CONVERSATION_FLOW_ID=' + flow.conversation_flow_id);
  console.log('Version=' + flow.version);
  console.log('=====');
  console.log('\nPaste RETELL_CONVERSATION_FLOW_ID into .env and run setup-retell-agent.mjs to attach it to an agent.');
}

main().catch(err => { console.error(err); process.exit(1); });
