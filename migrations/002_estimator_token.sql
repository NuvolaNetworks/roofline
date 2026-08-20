-- 002_estimator_token.sql — H1: the public instant-estimator must address an
-- org by a random, revocable token, never by its primary key.
--
-- The org PK used to ride in the QR/link URL (and onto printed yard signs), so
-- anyone holding an org's UUID could inject leads into its live pipeline
-- unauthenticated. estimator_token is unguessable and can be rotated to
-- invalidate old signs without touching the PK that every FK depends on.
--
-- Idempotent, like 001: safe to re-run.

ALTER TABLE orgs ADD COLUMN IF NOT EXISTS estimator_token TEXT;

-- Backfill existing orgs with a random token (v4 UUID, hyphens stripped).
UPDATE orgs
   SET estimator_token = replace(gen_random_uuid()::text, '-', '')
 WHERE estimator_token IS NULL;

-- Unique so a token resolves to exactly one org (NULLs are allowed and do not
-- collide, matching the sqlite backend).
CREATE UNIQUE INDEX IF NOT EXISTS orgs_estimator_token_idx
  ON orgs (estimator_token);
