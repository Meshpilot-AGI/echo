/**
 * DB-backed scheduled-call dispatcher.
 *
 * Runs in-process inside the Express server. Every SCHEDULER_TICK_MS it:
 *   1. Finds queued rows whose scheduledAt <= now(), atomically claims them
 *      by updating status='dispatching', and calls LiveKit to originate the
 *      outbound SIP call.
 *   2. Sweeps rows that have been 'dispatching' for > STUCK_AFTER_MS without
 *      terminal outcome — treats them as no-answer, applies retry backoff or
 *      final-fail tagging.
 *
 * Retry policy (configurable via env):
 *   attempts=0 → initial dispatch
 *   no-answer / dispatch-error → attempts=1, requeued at +RETRY_BACKOFF_1_MS
 *   no-answer / dispatch-error → attempts=2, requeued at +RETRY_BACKOFF_2_MS
 *   attempts >= MAX_ATTEMPTS   → status=failed, outcome=no_answer,
 *                                tag cod-no-answer written to Shopify
 *
 * Retry scheduledAt is always passed through DND adjustment so retries that
 * would fall in the 21:00–09:00 IST window roll to the next morning.
 *
 * Terminal outcomes are set by the LiveKit tool webhooks in server.js when
 * Priya calls confirm_order / cancel_order / request_human_agent /
 * request_callback — those handlers call markScheduledCallOutcome().
 */

import { triggerPipecatCall } from '../trigger-pipecat-call.js';
import { getShopBranding, getStoreCallWindow } from './shops.js';
import { adjustForDnd, isDnd } from './dnd.js';

// ── Tunables ──────────────────────────────────────────────────────────
const TICK_MS            = Number(process.env.SCHEDULER_TICK_MS        ?? 30_000);
const MAX_PER_TICK       = Number(process.env.SCHEDULER_MAX_PER_TICK   ?? 10);
const STUCK_AFTER_MS     = Number(process.env.SCHEDULER_STUCK_AFTER_MS ?? 5 * 60_000);
const MAX_ATTEMPTS       = Number(process.env.CALL_MAX_ATTEMPTS        ?? 3);
const RETRY_BACKOFF_1_MS = Number(process.env.CALL_RETRY_1_MS          ?? 30 * 60_000);  // 30min
const RETRY_BACKOFF_2_MS = Number(process.env.CALL_RETRY_2_MS          ?? 2 * 60 * 60_000); // 2h

// ── Shared-API concurrency caps ───────────────────────────────────────
// All 4 stores run through ONE LiveKit account, one ElevenLabs key, one
// Sarvam key, one OpenAI key, and one Vobiz SIP trunk. Every in-flight call
// holds a slot on each of those simultaneously (a LiveKit room + egress
// session, an ElevenLabs TTS stream, a Sarvam STT stream, an OpenAI LLM
// stream, and a Vobiz channel). Capping the number of SIMULTANEOUS calls is
// the single lever that keeps us under all of those third-party limits at
// once — it's what produced the "concurrent egress sessions limit exceeded"
// errors. MAX_PER_TICK still throttles the ramp rate; this bounds the ceiling.
// Raise SCHEDULER_MAX_CONCURRENT_CALLS as the LiveKit/ElevenLabs/Vobiz plans
// allow. Per-store cap keeps one store from monopolising the shared stack.
const MAX_CONCURRENT_CALLS     = Number(process.env.SCHEDULER_MAX_CONCURRENT_CALLS     ?? 3);
const MAX_CONCURRENT_PER_STORE = Number(process.env.SCHEDULER_MAX_CONCURRENT_PER_STORE ?? 2);

/**
 * COD_CONFIRM_RUNTIME selects the AI runtime for non-concierge profiles.
 *   livekit — existing LiveKit + Sarvam Bulbul path (default, safe).
 *   retell  — new Retell AI + Vobiz SIP path.
 *
 * Default is livekit until Retell+Vobiz is validated in production.
 */
export const COD_CONFIRM_RUNTIME = (process.env.COD_CONFIRM_RUNTIME || 'pipecat').toLowerCase();
const VALID_RUNTIMES = ['pipecat'];
if (!VALID_RUNTIMES.includes(COD_CONFIRM_RUNTIME)) {
  throw new Error(`Invalid COD_CONFIRM_RUNTIME: "${COD_CONFIRM_RUNTIME}". Must be one of: ${VALID_RUNTIMES.join(', ')}`);
}

/**
 * DISPATCH_MODE controls whether the scheduler actually places phone calls.
 *   live    — full production. triggerLivekitCall fires, customer receives
 *             a real PSTN call.
 *   dry_run — beta-test mode. Scheduler picks up due rows, logs the full
 *             payload, marks them done(dry_run), but DOES NOT call the
 *             customer. Lets you exercise the entire HMAC/allowlist/phone/
 *             DND/idempotency pipeline against real Shopify orders without
 *             ringing anyone's phone.
 *
 * Default: live (so a missing env doesn't surprise-disable production).
 * For first-store beta testing, set DISPATCH_MODE=dry_run in .env.
 */
export const DISPATCH_MODE = (process.env.DISPATCH_MODE || 'live').toLowerCase();
const VALID_MODES = ['live', 'dry_run'];
if (!VALID_MODES.includes(DISPATCH_MODE)) {
  throw new Error(`Invalid DISPATCH_MODE: "${DISPATCH_MODE}". Must be one of: ${VALID_MODES.join(', ')}`);
}

/**
 * Start the scheduler. Returns a stop() fn. Only one scheduler loop should
 * run per process — server.js calls startScheduler() once in app init.
 */
export function startScheduler(prisma, { onFinalFail } = {}) {
  let stopped = false;

  async function tick() {
    if (stopped) return;
    try {
      await Promise.all([
        dispatchDue(prisma, onFinalFail),
        sweepStuck(prisma, onFinalFail),
      ]);
    } catch (err) {
      console.error('[scheduler] tick error:', err);
    }
  }

  // Kick off one tick immediately, then interval.
  tick();
  const handle = setInterval(tick, TICK_MS);

  const modeLabel = DISPATCH_MODE === 'dry_run' ? '🔒 DRY-RUN (no real calls)' : '🟢 LIVE (real calls)';
  console.log(`[scheduler] started — mode=${modeLabel} runtime=${COD_CONFIRM_RUNTIME} tick=${TICK_MS}ms, max-per-tick=${MAX_PER_TICK}, stuck-after=${STUCK_AFTER_MS}ms, max-attempts=${MAX_ATTEMPTS}`);

  return function stop() {
    stopped = true;
    clearInterval(handle);
  };
}

async function dispatchDue(prisma, onFinalFail) {
  const now = new Date();

  // ── Shared-API concurrency gate ──────────────────────────────────────
  // Count calls already in-flight (claimed='dispatching', outcome not yet
  // landed). Each holds a live LiveKit room/egress + ElevenLabs/Sarvam/OpenAI
  // streams + a Vobiz channel. Never exceed MAX_CONCURRENT_CALLS across all
  // stores, nor MAX_CONCURRENT_PER_STORE for any one store. (Stuck rows
  // self-heal via the STUCK_AFTER_MS sweep, so the count can't deadlock.)
  const inflight = await prisma.scheduledCall.groupBy({
    by: ['shop'],
    where: { status: 'dispatching' },
    _count: { _all: true },
  });
  const perStore = new Map(inflight.map(g => [g.shop || '', g._count._all]));
  const totalInflight = inflight.reduce((a, g) => a + g._count._all, 0);

  const slots = Math.min(MAX_PER_TICK, MAX_CONCURRENT_CALLS - totalInflight);
  if (slots <= 0) {
    console.log(`[scheduler] concurrency cap hold — ${totalInflight}/${MAX_CONCURRENT_CALLS} calls in-flight`);
    return;
  }

  // Pull a generous window of due rows so per-store fairness can skip past a
  // store already at its cap without starving the others.
  const due = await prisma.scheduledCall.findMany({
    where: { status: 'queued', scheduledAt: { lte: now } },
    orderBy: { scheduledAt: 'asc' },
    take: Math.max(MAX_PER_TICK, MAX_CONCURRENT_CALLS * 4),
  });
  if (!due.length) return;

  let dispatched = 0;
  for (const row of due) {
    if (dispatched >= slots) break;
    const shopKey = row.shop || '';
    if ((perStore.get(shopKey) || 0) >= MAX_CONCURRENT_PER_STORE) continue; // store fairness

    // Claim atomically — if another tick or process raced us, skip.
    const claimed = await prisma.scheduledCall.updateMany({
      where: { id: row.id, status: 'queued' },
      data:  { status: 'dispatching', lastAttemptAt: now },
    });
    if (claimed.count === 0) continue;

    perStore.set(shopKey, (perStore.get(shopKey) || 0) + 1);
    dispatched++;
    dispatchOne(prisma, row, onFinalFail).catch(err =>
      console.error('[scheduler] dispatchOne threw unhandled:', err)
    );
  }
}

async function dispatchOne(prisma, row, onFinalFail) {
  const payload = row.payload || {};

  // ── DND / PER-STORE CALL-WINDOW GATE (authoritative) ────────────────
  // This is the ONE place every dispatch must pass through, so DND is
  // enforced no matter how the row got scheduled (explicit scheduledAt
  // via /calls/dispatch, clock drift, a retry that drifted into the
  // night, etc.). If the store is paused or we're inside its DND window,
  // we DON'T dial — we roll the row forward to the next safe time and
  // leave it 'queued'. Not counted as an attempt (it never rang).
  // The IST window/DND applies to India (cod-confirm / Vobiz). The `concierge`
  // profile is international (US/+1 via ConversationRelay); IST hours are wrong
  // for those callees, so skip the IST gate for it (TODO: per-callee-timezone
  // DND). The shared concurrency cap in dispatchDue still applies to all.
  const isConcierge = (row.profile || '') === 'concierge';
  const win = getStoreCallWindow(row.shop);
  const now = new Date();
  if (!isConcierge && !win.callsEnabled) {
    const retryAt = new Date(now.getTime() + 60 * 60_000); // re-check in 1h
    await prisma.scheduledCall.update({
      where: { id: row.id },
      data:  { status: 'queued', scheduledAt: retryAt },
    });
    console.log(`[scheduler] calls-paused ${row.orderName} (${row.shop}) — deferred to ${retryAt.toISOString()}`);
    return;
  }
  if (!isConcierge && isDnd(now, win)) {
    const next = adjustForDnd(now, win);
    await prisma.scheduledCall.update({
      where: { id: row.id },
      data:  { status: 'queued', scheduledAt: next },
    });
    console.log(`[scheduler] DND-deferred ${row.orderName} (${row.shop}) window=${win.endHour}:00-${win.startHour}:00 IST → ${next.toISOString()}`);
    return;
  }

  // ── DRY-RUN GATE ──────────────────────────────────────────────────
  // Beta-test mode: log everything, persist the dry-run, do not call
  // LiveKit. Customer never hears their phone ring.
  if (DISPATCH_MODE === 'dry_run') {
    console.log(`[scheduler] DRY-RUN dispatch ${row.orderName} (${row.shop}) phone=${row.phone} lang=${row.lang} payload=${JSON.stringify(payload)}`);
    await prisma.callAttempt.create({
      data: {
        shop: row.shop, orderId: row.orderId, orderName: row.orderName,
        phone: row.phone,
        disposition: 'dry_run',
        notes: 'DISPATCH_MODE=dry_run — no real call placed',
        endedAt: new Date(),
      },
    });
    await prisma.scheduledCall.update({
      where: { id: row.id },
      data:  { status: 'done', outcome: 'dry_run', attempts: { increment: 1 } },
    });
    console.log(`[scheduler] DRY-RUN done ${row.orderName} — flip DISPATCH_MODE=live to enable real calls`);
    return;
  }

  // ── LIVE PATH ─────────────────────────────────────────────────────
  // Split into two phases (issue #10):
  //   1. Place the outbound call. Failures here are "real" dispatch failures
  //      — requeue with backoff.
  //   2. Persist the attempt + update the scheduled row. Failures here happen
  //      AFTER the customer's phone may already be ringing. We MUST NOT
  //      auto-retry in that case, because we would place a duplicate call.
  let placement;
  try {
    // Per-shop branding only matters for COD-confirm today (multi-tenant
    // store-name override). Other profiles get an empty branding bag and
    // fall back to STORE_NAME / STORE_CATEGORY env.
    const branding = row.shop ? getShopBranding(row.shop) : {};
    const identity = { shop: row.shop, entityRef: row.orderId, entityName: row.orderName };

    // SOLE runtime: Pipecat + Vobiz (self-hosted Python bot on :3106).
    // LiveKit / Retell / Twilio-Relay runtimes removed 2026-08-06 (Echo E1.2a —
    // no managed voice-vendor lock-in). International/concierge (+1) routing is a
    // future re-add; today every call goes through the Pipecat/Vobiz path.
    placement = await triggerPipecatCall({
      phone:    row.phone,
      profile:  row.profile || 'cod-confirm',
      payload:  payload,
      identity,
      branding: { name: branding.name, category: branding.category },
    });
  } catch (err) {
    console.error(`[scheduler] dispatch failed ${row.orderName}:`, err?.message || err);
    await handleFailure(prisma, row, err?.message || String(err), onFinalFail);
    return;
  }

  // ── From here, the call was placed. Any failure below is POST-PLACEMENT
  //    bookkeeping and must NOT auto-requeue. Log loudly for manual recovery
  //    and leave the row in 'dispatching' so the stuck-sweep handles it only
  //    after STUCK_AFTER_MS with no terminal outcome — by which time the
  //    LiveKit tool webhooks will likely have landed an outcome anyway.
  const roomName = placement?.room_name || null;
  const sipCallId = placement?.sip?.sipCallId || placement?.sip?.sip_call_id || null;

  try {
    await prisma.callAttempt.create({
      data: {
        shop: row.shop, orderId: row.orderId, orderName: row.orderName,
        phone: row.phone, roomName, sipCallId,
      },
    });
    await prisma.scheduledCall.update({
      where: { id: row.id },
      data:  { roomName, sipCallId, attempts: { increment: 1 } },
    });
    const runtimeLabel = isConcierge ? 'relay' : COD_CONFIRM_RUNTIME;
    console.log(`[scheduler] dispatched ${row.orderName} (${row.shop}) runtime=${runtimeLabel} attempt=${row.attempts + 1} room=${roomName}`);
  } catch (err) {
    // Call is already live externally. Do NOT call handleFailure(), do NOT
    // requeue. Dump everything needed for manual reconciliation and move on.
    console.error(
      `[scheduler] POST-DISPATCH BOOKKEEPING FAILED for ${row.orderName} (${row.shop})` +
      ` — call was already placed (room=${roomName} sipCallId=${sipCallId}).` +
      ` NOT auto-retrying to avoid a duplicate call. Manual review needed.` +
      ` scheduledCall.id=${row.id} error=${err?.message || err}`
    );
  }
}

async function sweepStuck(prisma, onFinalFail) {
  const threshold = new Date(Date.now() - STUCK_AFTER_MS);
  const stuck = await prisma.scheduledCall.findMany({
    where: { status: 'dispatching', lastAttemptAt: { lt: threshold }, outcome: null },
    take: MAX_PER_TICK,
  });

  for (const row of stuck) {
    console.warn(`[scheduler] stuck-dispatch ${row.orderName} (${row.shop}) — treating as no-answer`);
    await handleFailure(prisma, row, 'no-answer (stuck-dispatch sweep)', onFinalFail);
  }
}

/**
 * Close the latest open CallAttempt for this scheduled call (if any).
 * Idempotent — if no open row exists (e.g. dispatch failed before the
 * attempt was created, or it was already closed), this is a no-op.
 *
 * Match priority: roomName → sipCallId → (shop, orderId) latest open. The
 * fallback by (shop, orderId) is necessary for cases where dispatchOne
 * threw before persisting roomName/sipCallId on the scheduledCall row.
 *
 * Issue #13: handleFailure() previously left CallAttempt rows open with
 * disposition=null, endedAt=null whenever the scheduler resolved a call
 * via no-answer / stuck-dispatch / final-fail. Tool-driven outcomes
 * (confirm/cancel/etc.) closed the attempt; failures didn't. Caused
 * orphaned half-rows that broke turnCount, audio joins, and dashboards.
 */
async function closeOpenAttempt(prisma, { shop, orderId, roomName, sipCallId }, disposition, notes) {
  if (!shop || !orderId) return null;
  let where;
  if (roomName) {
    where = { shop, orderId: String(orderId), roomName, endedAt: null };
  } else if (sipCallId) {
    where = { shop, orderId: String(orderId), sipCallId, endedAt: null };
  } else {
    where = { shop, orderId: String(orderId), endedAt: null };
  }
  const latest = await prisma.callAttempt.findFirst({
    where, orderBy: { startedAt: 'desc' },
  });
  if (!latest) return null;
  await prisma.callAttempt.update({
    where: { id: latest.id },
    data:  { endedAt: new Date(), disposition, notes },
  });
  return latest;
}

/**
 * Shared failure-handling: either requeue with backoff or finalize as failed.
 * attemptsAlreadyIncremented: dispatchOne increments on success-path.
 * For failures we decide based on row.attempts as it currently stands.
 *
 * Always closes the open CallAttempt — for retries, the previous attempt
 * is closed before the next dispatch creates a fresh one (one CallAttempt
 * per dispatch is the invariant). For final-fail, the attempt closes with
 * disposition='no_answer'. For pre-call dispatch errors the attempt may
 * not exist yet; closeOpenAttempt is a no-op in that case.
 */
async function handleFailure(prisma, row, reason, onFinalFail) {
  const nextAttempts = (row.attempts || 0) + 1;

  // Disposition reflects the failure mode. 'no_answer' for stuck-sweep
  // (call placed, customer never picked up); 'dispatch_error' for
  // pre-call failures (triggerLivekitCall threw — no SIP placed).
  const disposition = reason && reason.includes('stuck-dispatch') ? 'no_answer' : 'dispatch_error';
  await closeOpenAttempt(
    prisma,
    { shop: row.shop, orderId: row.orderId, roomName: row.roomName, sipCallId: row.sipCallId },
    disposition,
    reason,
  );

  if (nextAttempts >= MAX_ATTEMPTS) {
    await prisma.scheduledCall.update({
      where: { id: row.id },
      data: {
        status:    'failed',
        outcome:   'no_answer',
        attempts:  nextAttempts,
        lastError: reason,
      },
    });
    console.log(`[scheduler] FINAL FAIL ${row.orderName} after ${nextAttempts} attempts: ${reason}`);
    if (typeof onFinalFail === 'function') {
      try {
        await onFinalFail(row, reason);
      } catch (err) {
        console.error('[scheduler] onFinalFail threw:', err);
      }
    }
    return;
  }

  const backoffMs = nextAttempts === 1 ? RETRY_BACKOFF_1_MS : RETRY_BACKOFF_2_MS;
  const nextAt = adjustForDnd(new Date(Date.now() + backoffMs));

  await prisma.scheduledCall.update({
    where: { id: row.id },
    data: {
      status:        'queued',
      scheduledAt:   nextAt,
      attempts:      nextAttempts,
      lastError:     reason,
    },
  });

  console.log(`[scheduler] retry-queued ${row.orderName} attempt ${nextAttempts}/${MAX_ATTEMPTS} at ${nextAt.toISOString()}`);
}

/**
 * Called by LiveKit tool webhooks (confirm/cancel/agent/callback) to mark a
 * scheduled call as terminally resolved. Safe to call multiple times — first
 * outcome wins.
 */
export async function markScheduledCallOutcome(prisma, { shop, orderId, outcome, notes }) {
  if (!shop || !orderId || !outcome) return null;
  const row = await prisma.scheduledCall.findUnique({ where: { shop_orderId: { shop, orderId: String(orderId) } } });
  if (!row) return null;

  // Issue #11: atomic conditional update. The previous read-then-write could
  // race — two tool callbacks both observing outcome:null would both write,
  // letting the later call overwrite the first terminal outcome. updateMany
  // with outcome:null in the filter is a single SQL UPDATE ... WHERE outcome
  // IS NULL, so only the first write commits. The count tells us whether
  // WE were that first write.
  const claim = await prisma.scheduledCall.updateMany({
    where: { id: row.id, outcome: null },
    data: {
      status:    'done',
      outcome,
      lastError: null,
    },
  });

  if (claim.count === 0) {
    // Someone else got here first. Re-fetch for the current terminal state
    // and return it as a no-op — do NOT close an attempt either.
    const existing = await prisma.scheduledCall.findUnique({ where: { id: row.id } });
    console.log(`[scheduler] outcome=${outcome} ignored for ${shop}/${orderId} — already terminal (${existing?.outcome})`);
    return existing;
  }

  // We won the race — close the latest attempt record with OUR outcome.
  const latestAttempt = await prisma.callAttempt.findFirst({
    where: { shop, orderId: String(orderId), endedAt: null },
    orderBy: { startedAt: 'desc' },
  });
  if (latestAttempt) {
    await prisma.callAttempt.update({
      where: { id: latestAttempt.id },
      data: { endedAt: new Date(), disposition: outcome, notes },
    });
  }

  console.log(`[scheduler] outcome=${outcome} recorded for ${shop}/${orderId}`);
  return prisma.scheduledCall.findUnique({ where: { id: row.id } });
}
