-- Blueprint takeoffs. A rep drops plans (PDF/PNG/JPEG) on a job; AMOS reads
-- them into typed quantities for the trade (roof planes and linear feet,
-- pool shell and coping, building areas); a person reviews and corrects
-- every number; approving turns the reviewed takeoff into a proposal. The
-- extraction is advice: nothing is priced until a human approves.
-- Idempotent throughout.

CREATE TABLE IF NOT EXISTS takeoffs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id UUID NOT NULL REFERENCES orgs(id),
  job_id BIGINT NOT NULL REFERENCES jobs(id),
  file_id BIGINT NOT NULL REFERENCES files(id),
  trade TEXT NOT NULL,                 -- roofing|pool|construction
  status TEXT NOT NULL DEFAULT 'Reading',  -- Reading|Review|Approved|Failed
  extracted TEXT,                      -- JSON: what the model read, untouched
  reviewed TEXT,                       -- JSON: the quantities a person approved
  error TEXT,
  proposal_id BIGINT REFERENCES proposals(id),
  measurement_id BIGINT REFERENCES measurements(id),
  created_by BIGINT REFERENCES users(id),
  approved_by BIGINT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT to_char(timezone('utc', now()), 'YYYY-MM-DD HH24:MI:SS'),
  updated_at TEXT NOT NULL DEFAULT to_char(timezone('utc', now()), 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX IF NOT EXISTS takeoffs_org_job_idx ON takeoffs (org_id, job_id);
