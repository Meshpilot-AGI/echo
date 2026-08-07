/**
 * Retell recording fetcher + R2 uploader.
 *
 * Retell exposes a signed recording_url on the call_ended / call_analyzed
 * webhook and via GET /v2/get-call/{call_id}. This module downloads the
 * audio and uploads it to R2, then updates CallAttempt.audioUri.
 *
 * Env required:
 *   RETELL_API_KEY
 *   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
 *   RECORDING_BUCKET (or R2_RECORDING_BUCKET)
 *   RECORDING_PREFIX (defaults to "cod-confirm/")
 */

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const RETELL_API_KEY = process.env.RETELL_API_KEY || '';
const R2_BUCKET = process.env.R2_RECORDING_BUCKET || process.env.RECORDING_BUCKET || '';
const R2_PREFIX = process.env.RECORDING_PREFIX || 'cod-confirm/';

const r2 = (() => {
  const accountId = process.env.R2_ACCOUNT_ID || '';
  if (!accountId || !R2_BUCKET) return null;
  return new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
    },
  });
})();

function todaySlug() {
  const d = new Date();
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

function sanitizeShop(shop) {
  const slug = String(shop || '')
    .trim()
    .toLowerCase()
    .replace(/\.myshopify\.com$/, '')
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return slug || 'unknown';
}

/** Fetch call details from Retell (includes recording_url when available). */
export async function getRetellCall(callId) {
  if (!RETELL_API_KEY) throw new Error('RETELL_API_KEY not set');
  const res = await fetch(`https://api.retellai.com/v2/get-call/${callId}`, {
    headers: { Authorization: `Bearer ${RETELL_API_KEY}` },
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Retell get-call ${res.status}: ${txt.slice(0, 200)}`);
  }
  return res.json();
}

// SSRF guard. The recording_url arrives in a webhook payload; even though the
// call-event handler verifies Retell's signature, we defence-in-depth here so a
// recording URL can never make us fetch an internal/loopback/metadata address.
// Allow only https + a non-private host (Retell recordings live on public CDNs).
function assertSafeRecordingUrl(recordingUrl) {
  let u;
  try { u = new URL(recordingUrl); } catch { throw new Error(`bad recording_url: ${recordingUrl}`); }
  if (u.protocol !== 'https:') throw new Error(`refusing non-https recording_url: ${u.protocol}`);
  const h = u.hostname.toLowerCase();
  const blocked =
    h === 'localhost' || h.endsWith('.localhost') ||
    h === '169.254.169.254' || h === 'metadata.google.internal' ||
    /^(127\.|10\.|192\.168\.|169\.254\.|::1$|fe80:|fc00:|fd00:)/.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h);
  if (blocked) throw new Error(`refusing private/internal recording_url host: ${h}`);
}

/** Download the binary audio file from a signed URL. */
export async function downloadRetellRecording(recordingUrl) {
  assertSafeRecordingUrl(recordingUrl);
  const res = await fetch(recordingUrl);
  if (!res.ok) {
    throw new Error(`Retell recording download ${res.status}: ${recordingUrl}`);
  }
  const ct = res.headers.get('content-type') || 'audio/mpeg';
  const buf = Buffer.from(await res.arrayBuffer());
  return { buffer: buf, contentType: ct };
}

/** Upload buffer to R2. Returns s3:// URI. */
export async function uploadToR2(key, buffer, contentType = 'audio/mpeg', metadata = {}) {
  if (!r2) throw new Error('R2 not configured (R2_ACCOUNT_ID + bucket missing)');
  await r2.send(new PutObjectCommand({
    Bucket: R2_BUCKET,
    Key: key,
    Body: buffer,
    ContentType: contentType,
    Metadata: metadata,
  }));
  return `s3://${R2_BUCKET}/${key}`;
}

/**
 * Process a Retell recording from webhook payload or explicit callId.
 *
 * @param {object} opts
 * @param {string} opts.call_id          - Retell call_id
 * @param {string} [opts.recording_url]  - Signed URL from webhook (optional)
 * @param {string} [opts.shop]           - Shop slug from metadata
 * @param {string} [opts.orderId]        - From metadata
 * @param {import('@prisma/client').PrismaClient} opts.prisma
 */
export async function processRetellRecording({ call_id, recording_url, shop, orderId, prisma }) {
  if (!r2) {
    console.warn('[retell-rec] R2 not configured — skipping recording upload');
    return { ok: false, reason: 'r2_not_configured' };
  }
  if (!call_id) {
    return { ok: false, reason: 'missing_call_id' };
  }

  let url = recording_url;
  let callDetails = null;
  if (!url) {
    try {
      callDetails = await getRetellCall(call_id);
      url = callDetails?.recording_url || null;
    } catch (err) {
      console.warn(`[retell-rec] failed to fetch call details for ${call_id}:`, err.message);
      return { ok: false, reason: 'call_details_failed', error: err.message };
    }
  }
  if (!url) {
    return { ok: false, reason: 'no_recording_url' };
  }

  // Find matching CallAttempt by roomName (Retell call_id) or sipCallId.
  let attempt = await prisma.callAttempt.findFirst({
    where: { roomName: call_id },
    orderBy: { createdAt: 'desc' },
  });
  if (!attempt && orderId) {
    attempt = await prisma.callAttempt.findFirst({
      where: { orderId: String(orderId), endedAt: { not: null } },
      orderBy: { createdAt: 'desc' },
    });
  }
  if (!attempt) {
    console.warn(`[retell-rec] no matching CallAttempt for retell call_id=${call_id}`);
    return { ok: false, reason: 'no_match' };
  }

  try {
    const { buffer, contentType } = await downloadRetellRecording(url);
    const format = contentType.includes('wav') ? 'wav' : 'mp3';
    const storeSeg = sanitizeShop(shop || attempt.shop);
    const dateSeg = todaySlug();
    const key = `${R2_PREFIX}retell/${storeSeg}/${dateSeg}/${call_id}.${format}`;

    const audioUri = await uploadToR2(key, buffer, contentType, {
      carrier: 'retell',
      'call-id': call_id,
      shop: storeSeg,
      'duration-sec': String(callDetails?.duration_ms ? Math.round(callDetails.duration_ms / 1000) : ''),
    });

    await prisma.callAttempt.update({
      where: { id: attempt.id },
      data: {
        audioUri,
        audioFormat: format,
        audioDurationMs: callDetails?.duration_ms || attempt.audioDurationMs || null,
      },
    });

    console.log(`[retell-rec] uploaded ${call_id} → ${audioUri}`);
    return { ok: true, audioUri };
  } catch (err) {
    console.error(`[retell-rec] upload failed for ${call_id}:`, err.message);
    return { ok: false, reason: 'upload_failed', error: err.message };
  }
}
