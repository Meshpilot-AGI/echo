/**
 * appointment-remind profile barrel.
 *
 * Mounts the 4 tool callback routes that the LiveKit agent posts to when
 * the in-call LLM fires a terminal tool. Each handler currently logs the
 * payload and returns `{ ok: true }` — production wiring (Google Calendar
 * update, internal scheduler row, CRM hook) plugs in here when a paying
 * customer ships on this profile.
 *
 * Engine boundary (same contract as cod-confirm): exports `mount(app, deps)`.
 * Deps include the shared `requireToolAuth` middleware so this profile uses
 * the SAME secret as cod-confirm — single env var, single rotation.
 */
import express from 'express';

const TOOLS = ['confirm_appointment', 'reschedule_appointment', 'cancel_appointment', 'request_human_agent'];

export function mount(app, deps) {
  const { requireToolAuth, prisma } = deps;
  const router = express.Router();

  // PoC handler: log + persist a CallTurn row tagged role='tool' so the
  // dataset captures appointment-call outcomes even before a real backend
  // is wired. Production deployments override per-tool by mounting their
  // own route ahead of this profile (Express picks the first match).
  for (const name of TOOLS) {
    router.post(`/${name}`, async (req, res) => {
      const body = req.body || {};
      const appointmentId = body.appointment_id || null;
      console.log(`[tool ${name}] appointment_id=${appointmentId} payload=${JSON.stringify(body).slice(0, 300)}`);

      // Best-effort persistence: write one CallTurn row so the call has a
      // visible terminal-tool record. If prisma is unavailable (test boot)
      // we still return ok so the agent's flow completes.
      if (prisma && appointmentId) {
        try {
          await prisma.callTurn.create({
            data: {
              shop:       '_appointment-remind',
              orderId:    String(appointmentId),
              roomName:   body.room_name || `appt-${appointmentId}-${Date.now()}`,
              turnIndex:  999, // sentinel out-of-band index for terminal tools
              role:       'tool',
              text:       name,
              toolName:   name,
              toolArgs:   body,
              toolResult: 'ok',
              lang:       null,
              startedAt:  new Date(),
            },
          });
        } catch (err) {
          // Most likely cause: duplicate (roomName, turnIndex) unique violation
          // if the LLM fires the same tool twice. Non-fatal — we still ack
          // the agent so it doesn't retry forever.
          console.warn(`[tool ${name}] persistence skipped: ${err.message}`);
        }
      }

      res.json({ ok: true, tool: name, profile: 'appointment-remind' });
    });
  }

  app.use('/webhook/livekit/tool', express.json(), requireToolAuth, router);
}
