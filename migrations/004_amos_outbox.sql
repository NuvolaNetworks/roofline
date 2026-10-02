-- Outbox for everything Roofline sends to AMOS (domain events, email
-- requests). Rows are written in the same transaction as the change they
-- describe, then delivered by a retrying worker (lib/amos-outbox.ts) — so a
-- platform outage delays delivery but never loses it, and the idempotency
-- key lets AMOS drop duplicates from retries.
CREATE TABLE IF NOT EXISTS amos_outbox (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id UUID NOT NULL REFERENCES orgs(id),
  kind TEXT NOT NULL,                   -- event|email
  topic TEXT NOT NULL,                  -- e.g. proposal.signed, email.signature_request
  idempotency_key TEXT NOT NULL UNIQUE,
  payload TEXT NOT NULL,                -- JSON
  status TEXT NOT NULL DEFAULT 'pending',  -- pending|sending|delivered|dead
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL DEFAULT to_char(timezone('utc', now()), 'YYYY-MM-DD HH24:MI:SS'),
  claimed_at TEXT,
  last_error TEXT,
  response TEXT,                        -- JSON from AMOS (receipt / message id)
  created_at TEXT NOT NULL DEFAULT to_char(timezone('utc', now()), 'YYYY-MM-DD HH24:MI:SS'),
  delivered_at TEXT
);
CREATE INDEX IF NOT EXISTS amos_outbox_due_idx ON amos_outbox (status, next_attempt_at);
CREATE INDEX IF NOT EXISTS amos_outbox_org_idx ON amos_outbox (org_id, created_at);

-- Roofline's own Ed25519 service key for the AMOS app channel. The private
-- half is AES-256-GCM encrypted under a key derived from
-- ROOFLINE_SESSION_SECRET; the public half is published at
-- /.well-known/amos-app-service-key.json and pinned by the builder with the
-- AMOS `app_service_key_register` verb. One active row.
CREATE TABLE IF NOT EXISTS app_service_key (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  kid TEXT NOT NULL,
  public_key TEXT NOT NULL,          -- base64url, 32 bytes
  private_key_enc TEXT NOT NULL,     -- base64url(iv | tag | ciphertext of PKCS#8 DER)
  created_at TEXT NOT NULL DEFAULT to_char(timezone('utc', now()), 'YYYY-MM-DD HH24:MI:SS')
);
