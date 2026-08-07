#!/usr/bin/env node
/**
 * Sync Vobiz recordings → R2.
 *
 * Vobiz holds recordings for 30 days. This script fetches recordings
 * from the last N days, downloads them, uploads to R2, and updates
 * CallAttempt.audioUri.
 *
 * Run manually:
 *   node scripts/sync-vobiz-recordings.mjs --days 3
 *
 * Run from cron (daily at 04:35 UTC):
 *   35 4 * * * cd /home/support/.../apps/cod_confirm && node scripts/sync-vobiz-recordings.mjs --days 2 >> /tmp/vobiz-sync.log 2>&1
 *
 * Env: VOBIZ_AUTH_ID, VOBIZ_AUTH_TOKEN, DATABASE_URL, R2_* vars.
 */

import { PrismaClient } from '@prisma/client';
import { listVobizRecordings, processVobizRecording } from '../src/lib/vobiz-recordings.js';

const args = process.argv.slice(2);
let days = 2;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--days' && args[i + 1]) days = Number(args[i + 1]);
}

const prisma = new PrismaClient();

async function main() {
  const to   = new Date();
  const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const fromIso = from.toISOString();
  const toIso   = to.toISOString();

  console.log(`[vobiz-sync] fetching recordings ${fromIso.slice(0, 10)} → ${toIso.slice(0, 10)}`);

  let recs;
  try {
    recs = await listVobizRecordings(fromIso, toIso);
  } catch (e) {
    console.error('[vobiz-sync] list failed:', e.message);
    process.exit(1);
  }

  console.log(`[vobiz-sync] ${recs.length} recording(s) found`);

  let ok = 0, skip = 0, fail = 0;
  for (const rec of recs) {
    try {
      const res = await processVobizRecording(rec, prisma);
      if (res.ok) { ok++; } else { skip++; console.log('[vobiz-sync] skipped:', res.reason); }
    } catch (e) {
      fail++;
      console.error('[vobiz-sync] failed:', e.message);
    }
  }

  console.log(`[vobiz-sync] done — ok:${ok} skip:${skip} fail:${fail}`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
