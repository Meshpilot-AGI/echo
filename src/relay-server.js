/**
 * Twilio ConversationRelay backend for the international "concierge" voice agent.
 *
 * Twilio handles the telephony + ASR + ElevenLabs TTS natively (no LiveKit, no
 * SIP/SRTP/codec dance). This server is the BRAIN: it receives transcripts over
 * a WebSocket and streams back the LLM's text for Twilio to speak.
 *
 *   Caller ⇄ Twilio (ASR + ElevenLabs TTS) ⇄ WSS ⇄ this server ⇄ gpt-4.1-mini
 *
 * Protocol (https://www.twilio.com/docs/voice/twiml/connect/conversationrelay):
 *   ← setup    : { type:'setup', callSid, from, to, customParameters{...} }
 *   ← prompt   : { type:'prompt', voicePrompt:'<transcript>' }   (user spoke)
 *   ← interrupt: { type:'interrupt' }                            (barge-in)
 *   ← dtmf / error
 *   → text     : { type:'text', token:'…', last:bool }           (speak)
 *   → end      : { type:'end' }                                  (hang up)
 *
 * Per-call goal+context are passed as <Parameter> elements in the TwiML and
 * arrive in setup.customParameters — that's what makes one agent "multi-talented".
 */
import express from 'express';
import { WebSocketServer } from 'ws';
import OpenAI from 'openai';
import http from 'node:http';
import pkg from '@prisma/client';
import { markScheduledCallOutcome } from './lib/scheduler.js';

const { PrismaClient } = pkg;
const prisma = new PrismaClient();

// Persist one conversation turn (mirrors the LiveKit path's CallTurn rows) so
// international ConversationRelay calls are observable in the same tables.
async function persistTurn(s, role, text, toolName) {
  try {
    await prisma.callTurn.create({
      data: {
        roomName: s.callSid || 'relay',
        sipCallId: s.callSid || null,
        shop: s.shop || '_concierge_intl',
        orderId: s.entityRef || '',
        turnIndex: s.turnIndex++,
        role,
        text: text || '',
        toolName: toolName || null,
        lang: 'en-US',
        startedAt: new Date(),
      },
    });
  } catch (err) { /* non-fatal — never break the call for a log write */ }
}

const PORT = Number(process.env.RELAY_PORT || 3105);
const OPENAI_KEY = process.env.OPENAI_API_KEY_VOICE
  || (String(process.env.OPENAI_API_KEY || '').startsWith('sk-') ? process.env.OPENAI_API_KEY : '');
const OPENAI_BASE = process.env.OPENAI_API_BASE_VOICE || 'https://api.openai.com/v1';
const LLM_MODEL = process.env.OPENAI_LLM_MODEL || 'gpt-4.1-mini';

const openai = new OpenAI({ apiKey: OPENAI_KEY, baseURL: OPENAI_BASE });

function buildSystemPrompt(p) {
  const name = p.customer_name && p.customer_name !== 'Customer' ? p.customer_name : null;
  return [
    `You are ${p.agent_name || 'Alex'}, a warm, professional, concise voice agent on a US phone call for ${p.brand_name || 'our team'}.`,
    name ? `You are speaking with ${name}.` : `You don't know the caller's name; don't invent one.`,
    ``,
    `YOUR GOAL FOR THIS CALL:`,
    p.goal || 'have a brief, friendly check-in.',
    p.context ? `\nCONTEXT (reference naturally, don't read verbatim):\n${p.context}` : ``,
    ``,
    `STYLE: short sentences, one question at a time, natural and human, never robotic or salesy. Confirm key facts. If you don't understand after one clarification, wrap up politely. Never invent facts not in the context.`,
    `When the goal is met or the conversation winds down, say a warm goodbye and then call the complete_call tool. If the caller needs a human or it's out of scope, call escalate_human. If they want a callback, call request_callback.`,
  ].filter(Boolean).join('\n');
}

const TOOLS = [
  { type: 'function', function: { name: 'complete_call', description: 'Goal achieved or natural end. Records outcome + summary, then the call ends.', parameters: { type: 'object', properties: { outcome: { type: 'string' }, summary: { type: 'string' } }, required: ['outcome', 'summary'] } } },
  { type: 'function', function: { name: 'request_callback', description: 'Caller asked to be called back at a specific time.', parameters: { type: 'object', properties: { preferred_time: { type: 'string' } }, required: ['preferred_time'] } } },
  { type: 'function', function: { name: 'escalate_human', description: 'Caller needs a human / out of scope.', parameters: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] } } },
];

const app = express();
app.get('/relay/healthz', (_req, res) => res.json({ ok: true, model: LLM_MODEL, key: OPENAI_KEY ? OPENAI_KEY.slice(0, 7) + '…' : 'MISSING' }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/relay/ws' });

wss.on('connection', (ws) => {
  const session = { history: [], params: {}, callSid: null, done: false, shop: '_concierge_intl', entityRef: '', turnIndex: 0 };

  const send = (obj) => { try { ws.send(JSON.stringify(obj)); } catch {} };
  const speak = (text, last = true) => send({ type: 'text', token: text, last });

  async function respond(userText) {
    if (session.done) return;
    session.history.push({ role: 'user', content: userText });
    try {
      const completion = await openai.chat.completions.create({
        model: LLM_MODEL,
        temperature: 0.6,
        max_tokens: 120,
        messages: [{ role: 'system', content: buildSystemPrompt(session.params) }, ...session.history],
        tools: TOOLS,
        tool_choice: 'auto',
      });
      const msg = completion.choices[0].message;
      const toolCall = msg.tool_calls && msg.tool_calls[0];
      if (toolCall) {
        const fn = toolCall.function.name;
        let args = {}; try { args = JSON.parse(toolCall.function.arguments || '{}'); } catch {}
        console.log(`[relay] ${session.callSid} tool=${fn} ${JSON.stringify(args)}`);
        // brief verbal close, then hang up
        const bye = fn === 'request_callback'
          ? `Got it — we'll call you back then. Take care!`
          : fn === 'escalate_human'
            ? `No problem, I'll have someone follow up with you. Thanks!`
            : `Thanks so much — take care!`;
        session.done = true;
        await persistTurn(session, 'tool', JSON.stringify(args), fn);
        // Persist the outcome onto a matching ScheduledCall row (no-op for
        // ad-hoc demo calls with no row). complete_call→args.outcome.
        const outcome = fn === 'complete_call' ? (args.outcome || 'completed').slice(0, 40)
          : fn === 'request_callback' ? 'callback' : 'escalated';
        const notes = args.summary || args.preferred_time || args.reason || '';
        markScheduledCallOutcome(prisma, { shop: session.shop, orderId: session.entityRef, outcome, notes })
          .catch(() => {});
        speak(bye, true);
        setTimeout(() => send({ type: 'end' }), 3500);
        return;
      }
      const text = (msg.content || '').trim() || "Sorry, could you say that again?";
      session.history.push({ role: 'assistant', content: text });
      console.log(`[relay] ${session.callSid} → ${text.slice(0, 120)}`);
      await persistTurn(session, 'assistant', text);
      speak(text, true);
    } catch (err) {
      console.error('[relay] LLM error:', err.message);
      speak('Sorry, I had a little trouble there. Could you repeat that?', true);
    }
  }

  ws.on('message', async (data) => {
    let ev; try { ev = JSON.parse(data.toString()); } catch { return; }
    switch (ev.type) {
      case 'setup':
        session.callSid = ev.callSid;
        session.params = ev.customParameters || {};
        session.shop = session.params.shop || '_concierge_intl';
        session.entityRef = session.params.entity_ref || ev.callSid || '';
        console.log(`[relay] setup call=${ev.callSid} from=${ev.from} → ${ev.to} goal="${(session.params.goal || '').slice(0, 60)}"`);
        break;
      case 'prompt':
        if (ev.voicePrompt) { await persistTurn(session, 'user', ev.voicePrompt); await respond(ev.voicePrompt); }
        break;
      case 'interrupt':
        console.log(`[relay] ${session.callSid} interrupted`);
        break;
      case 'error':
        console.warn(`[relay] ${session.callSid} error: ${ev.description}`);
        break;
    }
  });

  ws.on('close', () => console.log(`[relay] ws closed call=${session.callSid}`));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[relay] ConversationRelay backend on 127.0.0.1:${PORT}  model=${LLM_MODEL}  openai=${OPENAI_KEY ? 'set' : 'MISSING'}`);
});
