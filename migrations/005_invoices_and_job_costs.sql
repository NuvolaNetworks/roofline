-- Real invoices from proposals, partial payments, and job costing.
--
-- An invoice now bills a share of a proposal — a percent (50% deposit) or
-- an amount, or "whatever is left" for the final payment — and is sent to
-- the homeowner by a hashed, expiring link (same pattern as e-signature).
-- amount_paid_cents tracks partial payments recorded against it.
--
-- job_costs is the money-out side of a job (materials, labor, subs,
-- permits, dumpsters, …) so the job page can show contract value,
-- invoiced, collected, outstanding, costs and profit in one place.
-- Idempotent throughout.

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS proposal_id BIGINT REFERENCES proposals(id);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS number TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS title TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS percent DOUBLE PRECISION;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS notes TEXT NOT NULL DEFAULT '';
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS amount_paid_cents BIGINT NOT NULL DEFAULT 0;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS token_hash TEXT UNIQUE;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS token_expires_at TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS viewed_at TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS voided_at TEXT;

ALTER TABLE payments ADD COLUMN IF NOT EXISTS received_on TEXT;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS note TEXT NOT NULL DEFAULT '';
ALTER TABLE payments ADD COLUMN IF NOT EXISTS recorded_by BIGINT REFERENCES users(id);

CREATE TABLE IF NOT EXISTS job_costs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id UUID NOT NULL REFERENCES orgs(id),
  job_id BIGINT NOT NULL REFERENCES jobs(id),
  category TEXT NOT NULL,          -- materials|labor|subcontractor|permit|disposal|equipment|other
  vendor TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  amount_cents BIGINT NOT NULL,
  incurred_on TEXT,
  file_id BIGINT REFERENCES files(id),
  created_by BIGINT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT to_char(timezone('utc', now()), 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX IF NOT EXISTS job_costs_job_idx ON job_costs (org_id, job_id);
