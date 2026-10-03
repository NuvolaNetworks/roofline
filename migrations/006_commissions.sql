-- Commission tracking. A rep's commission on a job is
--   (collected − job costs − overhead% × contract) × rep share%
-- with 8 Square's defaults of 10% overhead and a 50/50 split, configurable
-- per org. A job is due once it reaches Ready for Commission; paying it
-- records the amount and closes the job. commission_statements is the log
-- of the semimonthly (1st and 15th) statements emailed to each rep; its
-- unique key makes a statement send at most once per rep per period.
-- Idempotent throughout.

ALTER TABLE orgs ADD COLUMN IF NOT EXISTS commission_overhead_pct DOUBLE PRECISION NOT NULL DEFAULT 10;
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS commission_rep_share_pct DOUBLE PRECISION NOT NULL DEFAULT 50;
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS commission_statements_enabled INTEGER NOT NULL DEFAULT 1;

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS commission_paid_at TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS commission_paid_cents BIGINT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS commission_paid_by BIGINT REFERENCES users(id);

CREATE TABLE IF NOT EXISTS commission_statements (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id UUID NOT NULL REFERENCES orgs(id),
  period TEXT NOT NULL,
  user_id BIGINT NOT NULL REFERENCES users(id),
  total_cents BIGINT NOT NULL,
  job_count INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT to_char(timezone('utc', now()), 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, period, user_id)
);
CREATE INDEX IF NOT EXISTS commission_statements_org_idx ON commission_statements (org_id);
