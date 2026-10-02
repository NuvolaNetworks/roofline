-- Proposal templates, stored files, and native e-signature.
--
-- Templates become real documents: `body` holds the JSON block layout
-- (cover, line items, summary + signatures, attachments, rich text) that
-- lib/doc-template.ts parses. Rows created before this migration keep
-- body NULL and render with the built-in default layout.
--
-- Files (logos, spec sheets, signature images, signed PDFs) live in
-- Postgres as bytea — Roofline holds no object-store credentials, and the
-- volume is small (a few MB per signed proposal). Every file carries its
-- SHA-256 so signed documents can be fingerprinted in the audit trail.
--
-- Signing is an envelope (one frozen snapshot of the proposal, hashed) with
-- one row per signer. Signers reach the public signing page by a random
-- token; only its SHA-256 is stored. envelope_events is the append-only
-- audit trail printed on the certificate page.
--
-- Idempotent throughout (IF NOT EXISTS), like 001/002.

CREATE TABLE IF NOT EXISTS files (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id UUID NOT NULL REFERENCES orgs(id),
  purpose TEXT NOT NULL,          -- logo|attachment|signature|signed_pdf
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  sha256 TEXT NOT NULL,
  bytes BYTEA NOT NULL,
  created_at TEXT NOT NULL DEFAULT to_char(timezone('utc', now()), 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX IF NOT EXISTS files_org_idx ON files (org_id);

ALTER TABLE templates ADD COLUMN IF NOT EXISTS body TEXT;
ALTER TABLE templates ADD COLUMN IF NOT EXISTS updated_at TEXT;

ALTER TABLE proposals ADD COLUMN IF NOT EXISTS template_id BIGINT REFERENCES templates(id);
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS declined_at TEXT;

ALTER TABLE proposal_lines ADD COLUMN IF NOT EXISTS section TEXT NOT NULL DEFAULT '';
ALTER TABLE proposal_lines ADD COLUMN IF NOT EXISTS notes TEXT NOT NULL DEFAULT '';
ALTER TABLE proposal_lines ADD COLUMN IF NOT EXISTS position INTEGER NOT NULL DEFAULT 0;

ALTER TABLE catalogue ADD COLUMN IF NOT EXISTS section TEXT NOT NULL DEFAULT '';
ALTER TABLE catalogue ADD COLUMN IF NOT EXISTS spec_file_id BIGINT REFERENCES files(id);

CREATE TABLE IF NOT EXISTS signature_envelopes (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id UUID NOT NULL REFERENCES orgs(id),
  proposal_id BIGINT NOT NULL REFERENCES proposals(id),
  job_id BIGINT NOT NULL REFERENCES jobs(id),
  status TEXT NOT NULL DEFAULT 'Out for signature',  -- Out for signature|Completed|Declined|Voided
  snapshot TEXT NOT NULL,          -- canonical JSON of the frozen render model
  snapshot_sha256 TEXT NOT NULL,
  final_file_id BIGINT REFERENCES files(id),
  final_sha256 TEXT,
  created_by BIGINT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT to_char(timezone('utc', now()), 'YYYY-MM-DD HH24:MI:SS'),
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS signature_envelopes_proposal_idx ON signature_envelopes (org_id, proposal_id);

CREATE TABLE IF NOT EXISTS envelope_signers (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id UUID NOT NULL REFERENCES orgs(id),
  envelope_id BIGINT NOT NULL REFERENCES signature_envelopes(id),
  role TEXT NOT NULL,              -- customer|contractor
  name TEXT NOT NULL,
  email TEXT,
  user_id BIGINT REFERENCES users(id),   -- contractor signers sign in-app
  token_hash TEXT UNIQUE,                -- customer signers sign by link
  token_expires_at TEXT,
  status TEXT NOT NULL DEFAULT 'Pending',  -- Pending|Viewed|Signed|Declined
  viewed_at TEXT,
  signed_at TEXT,
  signature_file_id BIGINT REFERENCES files(id),
  signature_method TEXT,           -- drawn|typed
  typed_name TEXT,
  consent_text TEXT,
  ip TEXT,
  user_agent TEXT,
  decline_reason TEXT
);
CREATE INDEX IF NOT EXISTS envelope_signers_envelope_idx ON envelope_signers (envelope_id);

CREATE TABLE IF NOT EXISTS envelope_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id UUID NOT NULL REFERENCES orgs(id),
  envelope_id BIGINT NOT NULL REFERENCES signature_envelopes(id),
  signer_id BIGINT REFERENCES envelope_signers(id),
  event TEXT NOT NULL,             -- created|sent|viewed|consented|signed|declined|voided|completed
  detail TEXT,
  ip TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT to_char(timezone('utc', now()), 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX IF NOT EXISTS envelope_events_envelope_idx ON envelope_events (envelope_id);

ALTER TABLE documents ADD COLUMN IF NOT EXISTS file_id BIGINT REFERENCES files(id);
ALTER TABLE documents ADD COLUMN IF NOT EXISTS envelope_id BIGINT REFERENCES signature_envelopes(id);
