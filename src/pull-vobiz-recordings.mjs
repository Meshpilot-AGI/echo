/**
 * Pull recent Vobiz call recordings into R2 and link them to CallAttempt.
 *
 * The Pipecat answer XML now records each call (<Record recordSession>). This
 * job lists Vobiz recordings for a recent window and mirrors any not already in
 * R2 via processVobizRecording (matches by sipCallId=CallUUID -> download ->
 * R2 -> CallAttempt.audioUri). Run on a timer; idempotent (skips already-linked).
 */
import pkg from '@prisma/client';
import { listVobizRecordings, processVobizRecording } from './lib/vobiz-recordings.js';

const { PrismaClient } = pkg;
const prisma = new PrismaClient();

const WINDOW_DAYS = Number(process.env.VOBIZ_PULL_WINDOW_DAYS || 2);

async function main() {
  const now = new Date();
  const from = new Date(now.getTime() - WINDOW_DAYS * 24 * 3600 * 1000).toISOString();
  const to = new Date(now.getTime() + 24 * 3600 * 1000).toISOString(); // +1d for TZ safety
  let recs = [];
  try {
    recs = await listVobizRecordings(from, to);
  } catch (e) {
    console.error('[pull-rec] list failed:', e.message);
    process.exit(1);
  }
  // Vobiz ignores the from/to filter and returns the whole account, so narrow
  // client-side by add_time to only recent recordings (cheap + bounded).
  const cutoff = new Date(now.getTime() - WINDOW_DAYS * 24 * 3600 * 1000);
  const recent = recs.filter(r => {
    const t = r.add_time || r.recording_start_ms || r.created;
    if (!t) return true; // keep if no timestamp
    const d = new Date(String(t).replace(' ', 'T'));
    return isNaN(d) ? true : d >= cutoff;
  });
  let pulled = 0, skipped = 0, nomatch = 0;
  for (const rec of recent) {
    const callUuid = rec.call_uuid || rec.CallUUID || rec.calluuid;
    // idempotency: skip if this call's CallAttempt already has audio in R2
    if (callUuid) {
      const done = await prisma.callAttempt.findFirst({
        where: { sipCallId: callUuid, audioUri: { not: null } },
        select: { id: true },
      });
      if (done) { skipped++; continue; }
    }
    try {
      const r = await processVobizRecording(rec, prisma);
      if (r.ok) pulled++;
      else if (r.reason === 'no_match') nomatch++;
      else skipped++;
    } catch (e) {
      console.error('[pull-rec] process error for', callUuid, e.message);
      skipped++;
    }
  }
  console.log(`[pull-rec] window=${WINDOW_DAYS}d vobiz=${recs.length} recent=${recent.length} pulled=${pulled} skipped=${skipped} no_match=${nomatch}`);
  await prisma.$disconnect();
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
