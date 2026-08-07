-- Phase 2 of the multi-profile voice-agent generalization.
--
-- Add the `profile` column to ScheduledCall and CallAttempt so each row knows
-- which agent profile (cod-confirm, lead-qualify, appointment-remind, ...)
-- handled it. Defaulting to 'cod-confirm' keeps every existing row valid:
-- when this migration runs, every call in flight or in history was placed by
-- the COD-confirm profile, which is the truth.
--
-- Indexes on (profile, status, scheduledAt) and (profile, createdAt) so the
-- scheduler can poll one profile's queue without scanning the others — once
-- profile-specific schedulers actually exist in phase 3. For now there's a
-- single scheduler reading across profiles, but the index is cheap and ready.

ALTER TABLE "ScheduledCall"
  ADD COLUMN "profile" TEXT NOT NULL DEFAULT 'cod-confirm';

ALTER TABLE "CallAttempt"
  ADD COLUMN "profile" TEXT NOT NULL DEFAULT 'cod-confirm';

CREATE INDEX "ScheduledCall_profile_status_scheduledAt_idx"
  ON "ScheduledCall" ("profile", "status", "scheduledAt");

CREATE INDEX "CallAttempt_profile_createdAt_idx"
  ON "CallAttempt" ("profile", "createdAt");
