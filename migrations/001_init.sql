-- 001_init.sql — Roofline phase-2 schema: Postgres, org-scoped.
--
-- Idempotent (everything IF NOT EXISTS); the boot runner additionally records
-- applied files in schema_migrations so later files run exactly once.
--
-- Shape notes:
--   * org_id UUID NOT NULL on every business table — org is THE tenancy key,
--     always taken from the authenticated session / verified identity token,
--     never from client input.
--   * Integer ids stay integral (BIGINT IDENTITY) to match the sqlite demo
--     backend, so app SQL is identical across backends.
--   * Timestamps are TEXT in UTC "YYYY-MM-DD HH24:MI:SS" — the exact format
--     sqlite's datetime('now') emits. Deliberate: the whole read surface
--     (18 pages) formats/compares these as strings, and the format sorts
--     lexicographically. A later migration can move to timestamptz.

CREATE TABLE IF NOT EXISTS orgs (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  amos_tenant_id UUID UNIQUE,   -- links the org to its AMOS platform tenant
  created_at TEXT NOT NULL DEFAULT to_char(timezone('utc', now()), 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS users (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id UUID NOT NULL REFERENCES orgs(id),
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','manager','rep')),
  manager_id BIGINT REFERENCES users(id),
  password TEXT,                -- demo mode only; IdP users have none
  amos_sub TEXT,                -- platform IdP subject
  UNIQUE (org_id, email)
);
CREATE INDEX IF NOT EXISTS users_org_idx ON users (org_id);

CREATE TABLE IF NOT EXISTS contacts (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id UUID NOT NULL REFERENCES orgs(id),
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  address TEXT
);
CREATE INDEX IF NOT EXISTS contacts_org_idx ON contacts (org_id);

CREATE TABLE IF NOT EXISTS jobs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id UUID NOT NULL REFERENCES orgs(id),
  title TEXT NOT NULL,
  contact_id BIGINT REFERENCES contacts(id),
  address TEXT NOT NULL,
  trade TEXT NOT NULL,
  workflow TEXT NOT NULL DEFAULT 'Roofing',
  source TEXT NOT NULL,
  stage TEXT NOT NULL DEFAULT 'New lead',
  assignee_id BIGINT REFERENCES users(id),
  value_cents BIGINT NOT NULL DEFAULT 0,
  cost_cents BIGINT NOT NULL DEFAULT 0,
  scheduled_for TEXT,
  created_at TEXT NOT NULL DEFAULT to_char(timezone('utc', now()), 'YYYY-MM-DD HH24:MI:SS'),
  stage_since TEXT NOT NULL DEFAULT to_char(timezone('utc', now()), 'YYYY-MM-DD HH24:MI:SS'),
  updated_at TEXT NOT NULL DEFAULT to_char(timezone('utc', now()), 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX IF NOT EXISTS jobs_org_idx ON jobs (org_id);
CREATE INDEX IF NOT EXISTS jobs_org_stage_idx ON jobs (org_id, stage);

CREATE TABLE IF NOT EXISTS job_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id UUID NOT NULL REFERENCES orgs(id),
  job_id BIGINT NOT NULL REFERENCES jobs(id),
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  actor TEXT NOT NULL,
  direction TEXT NOT NULL DEFAULT 'internal',
  created_at TEXT NOT NULL DEFAULT to_char(timezone('utc', now()), 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX IF NOT EXISTS job_events_org_idx ON job_events (org_id);
CREATE INDEX IF NOT EXISTS job_events_job_idx ON job_events (job_id);

CREATE TABLE IF NOT EXISTS measurements (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id UUID NOT NULL REFERENCES orgs(id),
  job_id BIGINT NOT NULL REFERENCES jobs(id),
  provider TEXT NOT NULL,
  status TEXT NOT NULL,
  total_squares DOUBLE PRECISION,
  ridge_ft DOUBLE PRECISION,
  hip_ft DOUBLE PRECISION,
  valley_ft DOUBLE PRECISION,
  eave_ft DOUBLE PRECISION,
  rake_ft DOUBLE PRECISION,
  pitch TEXT,
  waste_pct DOUBLE PRECISION DEFAULT 12,
  created_at TEXT NOT NULL DEFAULT to_char(timezone('utc', now()), 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX IF NOT EXISTS measurements_org_idx ON measurements (org_id);
CREATE INDEX IF NOT EXISTS measurements_job_idx ON measurements (job_id);

CREATE TABLE IF NOT EXISTS catalogue (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id UUID NOT NULL REFERENCES orgs(id),
  sku TEXT NOT NULL,
  name TEXT NOT NULL,
  unit TEXT NOT NULL,
  price_cents BIGINT NOT NULL,
  cost_cents BIGINT NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'custom'
);
CREATE INDEX IF NOT EXISTS catalogue_org_idx ON catalogue (org_id);

CREATE TABLE IF NOT EXISTS proposals (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id UUID NOT NULL REFERENCES orgs(id),
  job_id BIGINT NOT NULL REFERENCES jobs(id),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Draft',   -- Draft|Sent|Viewed|Signed|Declined
  total_cents BIGINT NOT NULL DEFAULT 0,
  cost_cents BIGINT NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT to_char(timezone('utc', now()), 'YYYY-MM-DD HH24:MI:SS'),
  sent_at TEXT,
  viewed_at TEXT,
  signed_at TEXT
);
CREATE INDEX IF NOT EXISTS proposals_org_idx ON proposals (org_id);
CREATE INDEX IF NOT EXISTS proposals_job_idx ON proposals (job_id);

CREATE TABLE IF NOT EXISTS proposal_lines (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id UUID NOT NULL REFERENCES orgs(id),
  proposal_id BIGINT NOT NULL REFERENCES proposals(id),
  sku TEXT NOT NULL,
  name TEXT NOT NULL,
  unit TEXT NOT NULL,
  qty DOUBLE PRECISION NOT NULL,
  unit_price_cents BIGINT NOT NULL,
  unit_cost_cents BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS proposal_lines_org_idx ON proposal_lines (org_id);
CREATE INDEX IF NOT EXISTS proposal_lines_proposal_idx ON proposal_lines (proposal_id);

CREATE TABLE IF NOT EXISTS templates (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id UUID NOT NULL REFERENCES orgs(id),
  name TEXT NOT NULL,
  kind TEXT NOT NULL,        -- contract|coc|change_order|warranty|proposal
  fields TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS templates_org_idx ON templates (org_id);

CREATE TABLE IF NOT EXISTS documents (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id UUID NOT NULL REFERENCES orgs(id),
  job_id BIGINT NOT NULL REFERENCES jobs(id),
  template_id BIGINT REFERENCES templates(id),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Draft',   -- Draft|Sent|Signed
  signer TEXT,
  signed_at TEXT,
  created_at TEXT NOT NULL DEFAULT to_char(timezone('utc', now()), 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX IF NOT EXISTS documents_org_idx ON documents (org_id);
CREATE INDEX IF NOT EXISTS documents_job_idx ON documents (job_id);

CREATE TABLE IF NOT EXISTS material_orders (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id UUID NOT NULL REFERENCES orgs(id),
  job_id BIGINT NOT NULL REFERENCES jobs(id),
  proposal_id BIGINT REFERENCES proposals(id),
  supplier TEXT NOT NULL DEFAULT 'SRS Roof Hub',
  status TEXT NOT NULL DEFAULT 'Draft',   -- Draft|Pending approval|Ordered|Delivered
  total_cents BIGINT NOT NULL DEFAULT 0,
  deliver_on TEXT,
  created_at TEXT NOT NULL DEFAULT to_char(timezone('utc', now()), 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX IF NOT EXISTS material_orders_org_idx ON material_orders (org_id);
CREATE INDEX IF NOT EXISTS material_orders_job_idx ON material_orders (job_id);

CREATE TABLE IF NOT EXISTS work_orders (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id UUID NOT NULL REFERENCES orgs(id),
  job_id BIGINT NOT NULL REFERENCES jobs(id),
  trade TEXT NOT NULL,
  crew TEXT NOT NULL,
  scheduled_for TEXT,
  status TEXT NOT NULL DEFAULT 'Draft',   -- Draft|Sent|Accepted|Complete
  amount_cents BIGINT NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT to_char(timezone('utc', now()), 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX IF NOT EXISTS work_orders_org_idx ON work_orders (org_id);
CREATE INDEX IF NOT EXISTS work_orders_job_idx ON work_orders (job_id);

CREATE TABLE IF NOT EXISTS invoices (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id UUID NOT NULL REFERENCES orgs(id),
  job_id BIGINT NOT NULL REFERENCES jobs(id),
  kind TEXT NOT NULL,                     -- Deposit|Balance|Change order
  amount_cents BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Draft',   -- Draft|Sent|Paid|Overdue
  due_on TEXT,
  sent_at TEXT,
  paid_at TEXT,
  created_at TEXT NOT NULL DEFAULT to_char(timezone('utc', now()), 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX IF NOT EXISTS invoices_org_idx ON invoices (org_id);
CREATE INDEX IF NOT EXISTS invoices_job_idx ON invoices (job_id);

CREATE TABLE IF NOT EXISTS payments (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id UUID NOT NULL REFERENCES orgs(id),
  invoice_id BIGINT NOT NULL REFERENCES invoices(id),
  amount_cents BIGINT NOT NULL,
  method TEXT NOT NULL DEFAULT 'Card',
  reference TEXT,
  received_at TEXT NOT NULL DEFAULT to_char(timezone('utc', now()), 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX IF NOT EXISTS payments_org_idx ON payments (org_id);
CREATE INDEX IF NOT EXISTS payments_invoice_idx ON payments (invoice_id);

CREATE TABLE IF NOT EXISTS tasks (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id UUID NOT NULL REFERENCES orgs(id),
  job_id BIGINT REFERENCES jobs(id),
  assignee_id BIGINT REFERENCES users(id),
  title TEXT NOT NULL,
  due_on TEXT,
  done INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS tasks_org_idx ON tasks (org_id);

CREATE TABLE IF NOT EXISTS automations (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id UUID NOT NULL REFERENCES orgs(id),
  name TEXT NOT NULL,
  trigger TEXT NOT NULL,
  action TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'email',
  enabled INTEGER NOT NULL DEFAULT 1,
  runs INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS automations_org_idx ON automations (org_id);
