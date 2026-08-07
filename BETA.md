# Beta Testing Procedure

The COD confirm app supports two operational modes via the `DISPATCH_MODE`
env var:

| Mode | Behavior |
|------|----------|
| `dry_run` | Webhooks process fully, calls are queued, scheduler picks them up — but **no real LiveKit/SIP call is placed**. The full payload is logged and a `CallAttempt` row is written with `disposition='dry_run'`. |
| `live` | Production behavior. Real PSTN calls placed via Vobiz SIP trunk. |

Default if unset: `live` (so missing env doesn't surprise-disable production).

---

## Beta phase (current state)

**Status:** `DISPATCH_MODE=dry_run` for `<your-shop>.myshopify.com`.

What this means:
- Real Shopify orders flow into your webhook
- HMAC verification, allowlist, COD detection, phone normalization, DND
  window, idempotency, scheduler — every code path runs against real data
- After the 10-minute delay, the scheduler "dispatches" but only **logs**
  the payload that would have been sent to LiveKit
- The customer's phone never rings

Use this phase to:
1. Confirm real Shopify order webhooks arrive intact (HMAC matches)
2. Validate your customers' phone numbers normalize cleanly
3. See the actual call context Priya would receive (customer name, total,
   product, address) — catch any field-mapping bugs early
4. Verify DND adjusts correctly for late-evening orders
5. Watch for HMAC rejections / blocked-shop attempts in `/health`

---

## Inspecting dry-run results

### Live tail
```bash
sudo journalctl -u cod-confirm.service -f | grep -E "DRY-RUN|shopify|scheduler"
```

### Health snapshot
```bash
curl -s https://<your-server>/cod-confirm/health | jq
```
Look for `"dispatch_mode": "dry_run"` and `"queue.doneToday"` count.

### All dry-run dispatches in last 24h
```sql
SELECT "orderName", phone, payload, "createdAt", "updatedAt"
FROM "ScheduledCall"
WHERE outcome = 'dry_run'
  AND "createdAt" > now() - interval '1 day'
ORDER BY "createdAt" DESC;
```

### Reject counters (security visibility)
The `/health` endpoint surfaces `rejects.{hmac_missing,hmac_mismatch,shop_blocked}`
counters. Non-zero values during beta indicate either a misconfigured Shopify
webhook secret (HMAC mismatch) or a leaked endpoint URL (random POSTs).

---

## Promotion to live

When ready to flip your store to real calls:

```bash
# 1. Edit .env
sed -i 's/^DISPATCH_MODE=dry_run/DISPATCH_MODE=live/' /path/to/glitch-cod-confirm/.env

# 2. Restart
sudo systemctl restart cod-confirm.service

# 3. Confirm boot log
sudo journalctl -u cod-confirm.service -n 10 | grep "DISPATCH MODE"
# Expect: 🟢 LIVE — real customer calls will be placed

# 4. Confirm health
curl -s https://<your-server>/cod-confirm/health | jq .dispatch_mode
# Expect: "live"
```

After flipping live, the next COD order on your store will result in a
real customer call ~10 minutes later.

## Rollback to dry-run

If anything misbehaves after going live, revert with the same one-line
edit (`DISPATCH_MODE=dry_run`) + restart. Already-queued calls in the
DB will continue to dispatch under whatever mode is current at tick time
— so a panic-flip mid-day immediately stops further calls.

---

## Pre-launch checklist

Before flipping to `live` for the first time:

- [ ] Beta has run for ≥48 hours of real Shopify traffic with no anomalies
- [ ] All dry-run rows show normalized phone numbers (none `null`)
- [ ] No `hmac_mismatch` counts on `/health` (would indicate Shopify
      webhook secret drift)
- [ ] Vobiz DLT registration confirmed on the from-number
- [ ] LiveKit agent worker (`cod-confirm-agent.service`) is healthy:
      `sudo systemctl status cod-confirm-agent.service`
- [ ] One end-to-end test call placed via `flow-test-livekit` to a known
      Indian phone (you or a teammate) — confirm Priya speaks correctly,
      confirms the order, tags Shopify
- [ ] Decision: notify the store owner that real calls will start

---

## Operational reference

### Force-dispatch a queued row immediately (testing)
```sql
UPDATE "ScheduledCall"
SET "scheduledAt" = now() - interval '1 second'
WHERE "orderName" = '#NNNN';
```
The scheduler picks it up on the next 30s tick.

### Reset a row back to queued (after a transient failure)
```sql
UPDATE "ScheduledCall"
SET status = 'queued', attempts = 0, "lastError" = NULL,
    "scheduledAt" = now() + interval '5 minutes'
WHERE "orderName" = '#NNNN';
```

### Cancel a queued row before it fires
```sql
UPDATE "ScheduledCall"
SET status = 'failed', outcome = 'manually_cancelled'
WHERE "orderName" = '#NNNN' AND status = 'queued';
```

### Daily summary (for stand-up)
```sql
SELECT outcome, COUNT(*)
FROM "ScheduledCall"
WHERE "updatedAt" > now() - interval '1 day'
GROUP BY outcome
ORDER BY COUNT(*) DESC;
```
