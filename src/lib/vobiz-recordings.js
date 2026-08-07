/**
 * Vobiz recording fetcher + R2 uploader.
 *
 * Vobiz records all SIP trunk calls and holds them for 30 days.
 * This module downloads them from Vobiz API and uploads to R2 for
 * long-term storage, then updates CallAttempt.audioUri.
 *
 * Env required:
 *   VOBIZ_AUTH_ID     — Vobiz account auth ID (e.g. MA_xxxxxx)
 *   VOBIZ_AUTH_TOKEN  — Vobiz account auth token
 *   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
 *   R2_RECORDING_BUCKET — R2 bucket for call recordings (optional, defaults to RECORDING_BUCKET)
 */

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const VOBIZ_BASE = 'https://api.vobiz.ai/api/v1';
const AUTH_ID    = process.env.VOBIZ_AUTH_ID    || '';
const AUTH_TOKEN = process.env.VOBIZ_AUTH_TOKEN || '';

const R2_BUCKET = process.env.R2_RECORDING_BUCKET || process.env.RECORDING_BUCKET || '';
const R2_PREFIX = process.env.RECORDING_PREFIX    || 'cod-confirm/';

const r2 = (() => {
  const accountId = process.env.R2_ACCOUNT_ID || '';
  if (!accountId || !R2_BUCKET) return null;
  return new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId:     process.env.R2_ACCESS_KEY_ID     || '',
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
    },
  });
})();

function vobizHeaders() {
  return {
    'X-Auth-ID':    AUTH_ID,
    'X-Auth-Token': AUTH_TOKEN,
    'Content-Type': 'application/json',
  };
}

/** List Vobiz recordings between two ISO dates. Follows pagination. */
export async function listVobizRecordings(from, to) {
  if (!AUTH_ID || !AUTH_TOKEN) {
    throw new Error('VOBIZ_AUTH_ID and VOBIZ_AUTH_TOKEN required');
  }
  const base = new URL(`${VOBIZ_BASE}/Account/${AUTH_ID}/Recording/`);
  base.searchParams.set('from', from.slice(0, 10)); // YYYY-MM-DD
  base.searchParams.set('to',   to.slice(0, 10));

  const all = [];
  let nextUrl = base.toString();
  while (nextUrl) {
    const res = await fetch(nextUrl, { headers: vobizHeaders() });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`Vobiz list recordings ${res.status}: ${txt.slice(0, 200)}`);
    }
    const data = await res.json();
    const items = Array.isArray(data) ? data : (data.objects || data.recordings || data.data || []);
    all.push(...items);
    nextUrl = data.meta?.next
      ? (data.meta.next.startsWith('http')
          ? data.meta.next
          : data.meta.next.startsWith('/api/')
            ? `https://api.vobiz.ai${data.meta.next}`
            : `https://api.vobiz.ai/api${data.meta.next}`)
      : null;
  }
  return all;
}

/** Fetch recording metadata (includes recording_url). */
export async function getVobizRecording(recordingId) {
  const res = await fetch(
    `${VOBIZ_BASE}/Account/${AUTH_ID}/Recording/${recordingId}/`,
    { headers: vobizHeaders() }
  );
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Vobiz get recording ${res.status}: ${txt.slice(0, 200)}`);
  }
  return res.json();
}

/**
 * SSRF guard (2026-06-10, bug-2). The /webhook/vobiz/call-event endpoint is
 * public and unauthenticated, and recording_url comes straight from the
 * request body. Without this an attacker could point the fetch at the cloud
 * metadata endpoint or an internal service AND exfiltrate the Vobiz auth
 * headers we attach. Mirror retell-recordings.assertSafeRecordingUrl, but
 * additionally pin the host to api.vobiz.ai so the X-Auth headers can only
 * ever be sent to the real Vobiz API.
 */
function assertSafeVobizUrl(recordingUrl) {
  let u;
  try { u = new URL(recordingUrl); } catch { throw new Error(`bad recording_url: ${recordingUrl}`); }
  if (u.protocol !== 'https:') throw new Error(`refusing non-https recording_url: ${u.protocol}`);
  const h = u.hostname.toLowerCase();
  if (h !== 'api.vobiz.ai' && !h.endsWith('.vobiz.ai')) {
    throw new Error(`refusing recording_url host outside vobiz.ai: ${h}`);
  }
  const blocked =
    h === 'localhost' || h.endsWith('.localhost') ||
    h === '169.254.169.254' || h === 'metadata.google.internal' ||
    /^(127\.|10\.|192\.168\.|169\.254\.|::1$|fe80:|fc00:|fd00:)/.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h);
  if (blocked) throw new Error(`refusing private/internal recording_url host: ${h}`);
}

/** Download the binary audio file from Vobiz. */
export async function downloadVobizRecording(recordingUrl) {
  assertSafeVobizUrl(recordingUrl);
  const res = await fetch(recordingUrl, { headers: vobizHeaders() });
  if (!res.ok) {
    throw new Error(`Vobiz download ${res.status}: ${recordingUrl}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

/** Upload buffer to R2. Returns the public/URL string. */
export async function uploadToR2(key, buffer, contentType = 'audio/mp3') {
  if (!r2) throw new Error('R2 not configured (R2_ACCOUNT_ID + bucket missing)');
  await r2.send(new PutObjectCommand({
    Bucket: R2_BUCKET,
    Key: key,
    Body: buffer,
    ContentType: contentType,
  }));
  return `r2://${R2_BUCKET}/${key}`;
}

/**
 * Process one recording: download from Vobiz → upload to R2 → update DB.
 * @param {object} rec — Vobiz recording object
 * @param {import('@prisma/client').PrismaClient} prisma
 */
export async function processVobizRecording(rec, prisma) {
  const callUuid = rec.call_uuid || rec.CallUUID || rec.calluuid;
  const to       = rec.to_number || rec.to || rec.To || rec.from_number;
  // BUG-8 (2026-06-10): recording_duration_ms is already milliseconds, but
  // it was multiplied by 1000 again below (a 30s call -> 8.3h). Normalize to
  // ms here: use the _ms field as-is, treat duration/Duration as seconds.
  const durationMs = rec.recording_duration_ms != null
    ? Number(rec.recording_duration_ms)
    : Number(rec.duration || rec.Duration || 0) * 1000;
  const recId    = rec.recording_id || rec.id || rec.recordingId;
  const recUrl   = rec.recording_url || rec.recordingUrl || rec.url;
  const format   = (rec.recording_format || rec.format || rec.file_format || 'mp3').toLowerCase();

  if (!recUrl) {
    console.warn('[vobiz-rec] skipping — no recording_url', recId);
    return { ok: false, reason: 'no_url' };
  }

  // Match to CallAttempt by sipCallId (CallUUID) or by phone + time window.
  let attempt = null;
  if (callUuid) {
    attempt = await prisma.callAttempt.findFirst({
      where: { sipCallId: callUuid },
      orderBy: { createdAt: 'desc' },
    });
  }
  if (!attempt && to) {
    // BUG-8 (2026-06-10): a `contains` substring match (e.g. 919876543210
    // matching any stored phone containing those digits), a 7-day window, and
    // no shop scoping could attach a recording (PII audio) to a DIFFERENT
    // customer's CallAttempt. Use exact phone equality (covering the +/no-+
    // representations) and a 24h window — recordings complete within minutes.
    const phoneNorm = to.replace(/^\+/, '');
    const phoneCandidates = [...new Set([to, phoneNorm, `+${phoneNorm}`])];
    const after = new Date(Date.now() - 24 * 60 * 60 * 1000);
    attempt = await prisma.callAttempt.findFirst({
      where: {
        phone: { in: phoneCandidates },
        createdAt: { gte: after },
        audioUri: null, // only unmatched
      },
      orderBy: { createdAt: 'desc' },
    });
  }
  if (!attempt) {
    console.warn('[vobiz-rec] no matching CallAttempt for', { callUuid, to });
    return { ok: false, reason: 'no_match' };
  }

  // Download from Vobiz
  console.log(`[vobiz-rec] downloading ${recId} (${Math.round(durationMs/1000)}s) for attempt ${attempt.id}`);
  const buffer = await downloadVobizRecording(recUrl);

  // Upload to R2
  const shopSeg = (attempt.shop || 'unknown')
    .replace(/\.myshopify\.com$/, '')
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/-+/g, '-');
  const dateSeg = new Date().toISOString().slice(0, 10);
  const key = `${R2_PREFIX}${shopSeg}/${dateSeg}/${attempt.roomName || attempt.id}.${format}`;
  const audioUri = await uploadToR2(key, buffer, `audio/${format}`);

  // Update CallAttempt
  await prisma.callAttempt.update({
    where: { id: attempt.id },
    data: {
      audioUri,
      audioFormat: format,
      audioDurationMs: durationMs,
      audioSampleRate: 8000,
    },
  });

  console.log(`[vobiz-rec] uploaded → ${audioUri}`);
  return { ok: true, attemptId: attempt.id, audioUri };
}
