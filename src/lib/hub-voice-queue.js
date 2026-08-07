/**
 * Mesh Pilot per-brand voice queue mirror for Echo.
 *
 * Echo's local Prisma DB (`shopify_app.ScheduledCall`) is per-shop.
 * That's correct for the call-placement runtime, but it means
 * cockpit surfaces that read brand-attributed voice data
 * (`core.voice_call_queue` in the hub) don't see Echo's calls at
 * all. This module is the write bridge: every time Echo enqueues
 * or finalizes a `ScheduledCall`, mirror the brand-attributed
 * minimum into `core.voice_call_queue`.
 *
 * Architecture (DASH-VOICE-1, 2026-05-26):
 *   - brand_id is resolved via `lib/hub-context.js::canonicalBrandIdForShopSync(shop)`
 *     (populated by the boot audit; same source of truth used by
 *     `getShopBranding`).
 *   - source = 'shopify_cod' (matches the existing
 *     `routes/webhooks_shopify.py` insert template).
 *   - external_system = 'shopify', external_ref = order_id —
 *     same unique-key shape so Echo's mirror and the dashboard's
 *     own Shopify webhook path can coexist (the (brand, system,
 *     ref) EXCLUDE constraint dedupes).
 *
 * Failure policy: hub writes are best-effort. A blip in the hub
 * DB must never block a real outbound call. Every entrypoint
 * here is wrapped in try/catch; failures log to stderr and
 * return null so callers can treat the bridge as a side-effect
 * that may not have happened.
 *
 * Reuses the `pg` Pool created in `lib/hub-context.js`. We
 * intentionally don't open a second pool — keeps the connection
 * count stable and respects the same env contract
 * (`POSTGRES_BRAIN_URL`).
 */
import pg from 'pg';

import { canonicalBrandIdForShopSync } from './hub-context.js';

const { Pool } = pg;

// Echo outcome enum → core.voice_call_queue outcome enum mapping.
// voice_call_queue accepts: confirmed | rescheduled | declined | no_answer
// | voicemail | wrong_number | fake_order | other. Echo's runtime
// produces: confirmed | cancelled | no_answer | busy | failed |
// agent_needed | callback_requested | timeout. Map liberally; unknowns
// land as 'other' rather than failing the insert.
const OUTCOME_MAP = {
  confirmed:           'confirmed',
  cancelled:           'declined',
  no_answer:           'no_answer',
  busy:                'no_answer',
  failed:              'other',
  agent_needed:        'other',
  callback_requested:  'rescheduled',
  timeout:             'no_answer',
};

// Echo scheduledCall.status → voice_call_queue.status. voice_call_queue
// accepts: queued | calling | completed | failed | cancelled. Echo runs
// through: queued | dispatching | done | failed.
const STATUS_MAP = {
  queued:      'queued',
  dispatching: 'calling',
  done:        'completed',
  failed:      'failed',
};

let _pool = null;

function ensurePool() {
  if (_pool) return _pool;
  const url = process.env.POSTGRES_BRAIN_URL || process.env.HUB_DB_URL || '';
  if (!url) return null;
  _pool = new Pool({
    connectionString: url,
    max: 3,
    idleTimeoutMillis: 30_000,
  });
  _pool.on('error', err => {
    console.warn('[hub-voice-queue] pg pool error (non-fatal):', err.message);
  });
  return _pool;
}

/**
 * Mirror an Echo `ScheduledCall` insertion into `core.voice_call_queue`.
 *
 * Resolves brand_id via the canonical shop→brand_id cache. Skips
 * silently if the shop has no resolved canonical brand_id — this
 * keeps Echo working in hub-detached environments or for
 * unprovisioned brands.
 *
 * Uniqueness is enforced server-side by the
 * `voice_call_queue_brand_extref_unique` EXCLUDE constraint on
 * `(brand_id, external_system, external_ref)`. Echo's webhook
 * upsert is idempotent (Shopify retries up to 48h); this mirror
 * follows the same idempotency by catching the duplicate-key error
 * and treating it as a no-op.
 *
 * Returns the inserted row id, the existing row id on dedup, or
 * null on any error (logged).
 */
export async function enqueueHubVoiceCall({
  shop,
  phone,
  customer_name,
  order_id,
  order_name,
  payload,
  scheduled_for,
}) {
  const pool = ensurePool();
  if (!pool) return null;
  if (!shop || !phone || !order_id) return null;

  const brandId = canonicalBrandIdForShopSync(shop);
  if (!brandId) {
    console.warn(
      `[hub-voice-queue] skipping enqueue — no canonical brand_id for shop=${shop} order=${order_id}`,
    );
    return null;
  }

  // Carry Echo's full payload plus the Shopify order_name so cockpit
  // surfaces can show "#1234" without joining back to Echo's DB.
  const queuePayload = {
    ...(payload || {}),
    shopify_order_name: order_name || null,
    shop_domain: shop,
    echo_origin: 'cod-confirm.service',
  };

  try {
    const { rows } = await pool.query(
      `INSERT INTO core.voice_call_queue
             (brand_id, source, target_phone, target_name,
              external_ref, external_system, payload, status, scheduled_for)
       VALUES ($1, 'shopify_cod', $2, $3, $4, 'shopify', $5::jsonb, 'queued', $6)
       RETURNING id`,
      [
        brandId,
        String(phone),
        customer_name || null,
        String(order_id),
        JSON.stringify(queuePayload),
        scheduled_for ? new Date(scheduled_for) : new Date(),
      ],
    );
    return Number(rows[0].id);
  } catch (err) {
    // The EXCLUDE constraint surfaces as a generic SQL error; check the
    // error text. Duplicate is benign — Echo already has the row, the
    // hub mirror is consistent.
    if (String(err.message || '').includes('voice_call_queue_brand_extref_unique')) {
      try {
        const { rows } = await pool.query(
          `SELECT id FROM core.voice_call_queue
            WHERE brand_id = $1
              AND external_system = 'shopify'
              AND external_ref = $2`,
          [brandId, String(order_id)],
        );
        return rows[0] ? Number(rows[0].id) : null;
      } catch {
        return null;
      }
    }
    console.warn(
      `[hub-voice-queue] enqueue failed brand=${brandId} order=${order_id} reason=${err.message}`,
    );
    return null;
  }
}

/**
 * Mirror a terminal outcome (or status change) for an Echo
 * `ScheduledCall` into `core.voice_call_queue`. Looks up the row by
 * the unique `(brand_id, external_system='shopify', external_ref=order_id)`
 * tuple. No-op if the matching hub row doesn't exist (e.g. enqueue
 * mirror failed, brand unprovisioned, hub was unreachable at enqueue).
 *
 * Maps Echo's outcome + status vocab into the hub's narrower enums.
 * Unknown outcomes land as 'other' so the insert never blocks on an
 * unmapped value.
 *
 * `dialer_call_id` is optional but valuable — it lets a future cockpit
 * surface deep-link from a voice_call_queue row back to the LiveKit
 * room / Vobiz SIP call id.
 */
export async function markHubVoiceCallOutcome({
  shop,
  order_id,
  status,
  outcome,
  dialer_call_id,
  completed_at,
}) {
  const pool = ensurePool();
  if (!pool) return null;
  if (!shop || !order_id) return null;

  const brandId = canonicalBrandIdForShopSync(shop);
  if (!brandId) return null;

  const hubStatus = STATUS_MAP[status] || 'completed';
  const hubOutcome = outcome ? (OUTCOME_MAP[outcome] || 'other') : null;
  const completedAt = completed_at
    ? new Date(completed_at)
    : (hubStatus === 'completed' || hubStatus === 'failed' || hubStatus === 'cancelled')
      ? new Date()
      : null;

  try {
    const { rowCount } = await pool.query(
      `UPDATE core.voice_call_queue
          SET status         = $3,
              outcome        = COALESCE($4, outcome),
              dialer_call_id = COALESCE($5, dialer_call_id),
              completed_at   = COALESCE($6, completed_at)
        WHERE brand_id        = $1
          AND external_system = 'shopify'
          AND external_ref    = $2`,
      [
        brandId,
        String(order_id),
        hubStatus,
        hubOutcome,
        dialer_call_id || null,
        completedAt,
      ],
    );
    return rowCount;
  } catch (err) {
    console.warn(
      `[hub-voice-queue] outcome update failed brand=${brandId} order=${order_id} reason=${err.message}`,
    );
    return null;
  }
}

/**
 * Tear down the pool. Called from server.js graceful shutdown.
 */
export async function closeHubVoiceQueuePool() {
  if (_pool) {
    try { await _pool.end(); } catch { /* swallow */ }
    _pool = null;
  }
}
