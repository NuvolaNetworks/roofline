// Demo/dev backend: node:sqlite (Node >= 22, zero native deps — matters
// because our npm hardening disables install scripts). Used only when
// DATABASE_URL is unset. Schema + seed run idempotently at first touch; the
// schema mirrors migrations/001_init.sql (org_id and all), so queries are
// identical across backends and the demo differs from production only in
// where the bytes live.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Db, RunResult, SqlValue, Stage } from "./db.ts";
import {
  DEMO_ORG_ID,
  DEMO_ORG_NAME,
  DEMO_ESTIMATOR_TOKEN,
  DEMO_USERS,
  DEMO_CONTACTS,
  DEMO_JOBS,
  DEFAULT_CATALOGUE,
  DEFAULT_TEMPLATES,
  DEFAULT_AUTOMATIONS,
} from "./demo-fixtures.ts";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS orgs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    amos_tenant_id TEXT UNIQUE,
    estimator_token TEXT UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES orgs(id),
    email TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin','manager','rep')),
    manager_id INTEGER REFERENCES users(id),
    password TEXT,
    amos_sub TEXT,
    UNIQUE (org_id, email)
  );
  CREATE TABLE IF NOT EXISTS contacts (
    id INTEGER PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES orgs(id),
    name TEXT NOT NULL, type TEXT NOT NULL,
    phone TEXT, email TEXT, address TEXT
  );
  CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES orgs(id),
    title TEXT NOT NULL,
    contact_id INTEGER REFERENCES contacts(id),
    address TEXT NOT NULL,
    trade TEXT NOT NULL,
    workflow TEXT NOT NULL DEFAULT 'Roofing',
    source TEXT NOT NULL,
    stage TEXT NOT NULL DEFAULT 'New lead',
    assignee_id INTEGER REFERENCES users(id),
    value_cents INTEGER NOT NULL DEFAULT 0,
    cost_cents INTEGER NOT NULL DEFAULT 0,
    scheduled_for TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    stage_since TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS job_events (
    id INTEGER PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES orgs(id),
    job_id INTEGER NOT NULL REFERENCES jobs(id),
    kind TEXT NOT NULL, body TEXT NOT NULL, actor TEXT NOT NULL,
    direction TEXT NOT NULL DEFAULT 'internal',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS measurements (
    id INTEGER PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES orgs(id),
    job_id INTEGER NOT NULL REFERENCES jobs(id),
    provider TEXT NOT NULL, status TEXT NOT NULL,
    total_squares REAL,
    ridge_ft REAL, hip_ft REAL, valley_ft REAL, eave_ft REAL, rake_ft REAL,
    pitch TEXT, waste_pct REAL DEFAULT 12,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS catalogue (
    id INTEGER PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES orgs(id),
    sku TEXT NOT NULL, name TEXT NOT NULL, unit TEXT NOT NULL,
    price_cents INTEGER NOT NULL, cost_cents INTEGER NOT NULL DEFAULT 0,
    source TEXT NOT NULL DEFAULT 'custom'
  );
  CREATE TABLE IF NOT EXISTS proposals (
    id INTEGER PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES orgs(id),
    job_id INTEGER NOT NULL REFERENCES jobs(id),
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'Draft',   -- Draft|Sent|Viewed|Signed|Declined
    total_cents INTEGER NOT NULL DEFAULT 0,
    cost_cents INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    sent_at TEXT, viewed_at TEXT, signed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS proposal_lines (
    id INTEGER PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES orgs(id),
    proposal_id INTEGER NOT NULL REFERENCES proposals(id),
    sku TEXT NOT NULL, name TEXT NOT NULL, unit TEXT NOT NULL,
    qty REAL NOT NULL, unit_price_cents INTEGER NOT NULL,
    unit_cost_cents INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS templates (
    id INTEGER PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES orgs(id),
    name TEXT NOT NULL,
    kind TEXT NOT NULL,        -- contract|coc|change_order|warranty|proposal
    fields TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES orgs(id),
    job_id INTEGER NOT NULL REFERENCES jobs(id),
    template_id INTEGER REFERENCES templates(id),
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'Draft',   -- Draft|Sent|Signed
    signer TEXT, signed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS material_orders (
    id INTEGER PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES orgs(id),
    job_id INTEGER NOT NULL REFERENCES jobs(id),
    proposal_id INTEGER REFERENCES proposals(id),
    supplier TEXT NOT NULL DEFAULT 'SRS Roof Hub',
    status TEXT NOT NULL DEFAULT 'Draft',   -- Draft|Pending approval|Ordered|Delivered
    total_cents INTEGER NOT NULL DEFAULT 0,
    deliver_on TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS work_orders (
    id INTEGER PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES orgs(id),
    job_id INTEGER NOT NULL REFERENCES jobs(id),
    trade TEXT NOT NULL, crew TEXT NOT NULL,
    scheduled_for TEXT,
    status TEXT NOT NULL DEFAULT 'Draft',   -- Draft|Sent|Accepted|Complete
    amount_cents INTEGER NOT NULL DEFAULT 0,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS invoices (
    id INTEGER PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES orgs(id),
    job_id INTEGER NOT NULL REFERENCES jobs(id),
    kind TEXT NOT NULL,                     -- Deposit|Balance|Change order
    amount_cents INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'Draft',   -- Draft|Sent|Paid|Overdue
    due_on TEXT, sent_at TEXT, paid_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES orgs(id),
    invoice_id INTEGER NOT NULL REFERENCES invoices(id),
    amount_cents INTEGER NOT NULL,
    method TEXT NOT NULL DEFAULT 'Card',
    reference TEXT,
    received_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES orgs(id),
    job_id INTEGER REFERENCES jobs(id),
    assignee_id INTEGER REFERENCES users(id),
    title TEXT NOT NULL, due_on TEXT,
    done INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS automations (
    id INTEGER PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES orgs(id),
    name TEXT NOT NULL, trigger TEXT NOT NULL, action TEXT NOT NULL,
    channel TEXT NOT NULL DEFAULT 'email',
    enabled INTEGER NOT NULL DEFAULT 1,
    runs INTEGER NOT NULL DEFAULT 0
  );
`;

export function createSqliteDb(): Db {
  const path = process.env.ROOFLINE_SQLITE_PATH || "data/roofline.db";
  const dir = dirname(path);
  if (dir && dir !== ".") mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  seed(db);
  const api: Db = {
    async all<T = Record<string, unknown>>(sql: string, ...params: SqlValue[]): Promise<T[]> {
      return db.prepare(sql).all(...params) as T[];
    },
    async get<T = Record<string, unknown>>(sql: string, ...params: SqlValue[]): Promise<T | undefined> {
      return db.prepare(sql).get(...params) as T | undefined;
    },
    async run(sql: string, ...params: SqlValue[]): Promise<RunResult> {
      const r = db.prepare(sql).run(...params);
      return { lastId: Number(r.lastInsertRowid ?? 0), changes: Number(r.changes) };
    },
    // Single connection, so the same handle serves inside the transaction.
    async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      db.exec("BEGIN");
      try {
        const result = await fn(api);
        db.exec("COMMIT");
        return result;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
    async close(): Promise<void> {
      db.close();
    },
  };
  return api;
}

function seed(d: DatabaseSync) {
  const n = d.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number };
  if (n.n > 0) return;

  const org = DEMO_ORG_ID;
  d.prepare("INSERT INTO orgs (id, name, amos_tenant_id, estimator_token) VALUES (?,?,NULL,?)").run(
    org, DEMO_ORG_NAME, DEMO_ESTIMATOR_TOKEN,
  );

  const u = d.prepare(
    "INSERT INTO users (org_id, email, name, role, manager_id, password) VALUES (?,?,?,?,?,?)",
  );
  const userIds: number[] = [];
  for (const [email, name, role, managerIdx, password] of DEMO_USERS) {
    const managerId = managerIdx === null ? null : userIds[managerIdx];
    userIds.push(Number(u.run(org, email, name, role, managerId, password).lastInsertRowid));
  }

  const c = d.prepare(
    "INSERT INTO contacts (org_id, name, type, phone, email, address) VALUES (?,?,?,?,?,?)",
  );
  const contactIds: number[] = [];
  for (const row of DEMO_CONTACTS) {
    contactIds.push(Number(c.run(org, ...row).lastInsertRowid));
  }

  const j = d.prepare(
    `INSERT INTO jobs (org_id, title, contact_id, address, trade, workflow, source, stage, assignee_id,
                       value_cents, cost_cents, scheduled_for, stage_since)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?, datetime('now', ?))`,
  );
  const jobIds: number[] = [];
  for (const [title, contactIdx, address, trade, workflow, source, stage, assigneeIdx, value, cost, scheduled, since] of DEMO_JOBS) {
    jobIds.push(
      Number(
        j.run(org, title, contactIds[contactIdx], address, trade, workflow, source, stage as Stage,
              userIds[assigneeIdx], value, cost, scheduled, since).lastInsertRowid,
      ),
    );
  }

  const e = d.prepare(
    "INSERT INTO job_events (org_id, job_id, kind, body, actor, direction) VALUES (?,?,?,?,?,?)",
  );
  e.run(org, jobIds[0], "system", "Lead created from insurance referral (Sandra Kim, State Farm)", "system", "internal");
  e.run(org, jobIds[0], "email", "Sent proposal PDF to luc.p@example.com — viewed 2x", "Marcus Lee", "outbound");
  e.run(org, jobIds[0], "email", "Homeowner: 'Looks good, when can you start?'", "Luc Pamella", "inbound");
  e.run(org, jobIds[0], "stage", "Contract signed via PDF Signer → Approved; 50% deposit paid", "Marcus Lee", "internal");
  e.run(org, jobIds[4], "note", "Homeowner prefers install after 9am; dogs in backyard", "Marcus Lee", "internal");
  e.run(org, jobIds[2], "email", "Sub crew (framing) confirmed for the 15th", "Priya Nair", "outbound");
  e.run(org, jobIds[8], "sms", "Texted homeowner to schedule the inspection window", "Marcus Lee", "outbound");
  e.run(org, jobIds[3], "email", "Builder asked for per-lot pricing breakdown", "Birdseye Builders", "inbound");

  const m = d.prepare(
    `INSERT INTO measurements (org_id, job_id, provider, status, total_squares, ridge_ft, hip_ft, valley_ft, eave_ft, rake_ft, pitch)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  );
  m.run(org, jobIds[0], "gaf_quickmeasure", "delivered", 32.4, 64, 38, 41, 152, 96, "6/12");
  m.run(org, jobIds[5], "solar_estimate", "delivered", 28.1, null, null, null, null, null, "5/12 (est)");
  m.run(org, jobIds[6], "eagleview", "delivered", 41.7, 88, 12, 56, 178, 104, "8/12");
  m.run(org, jobIds[10], "eagleview", "ordered", null, null, null, null, null, null, null);

  const cat = d.prepare(
    "INSERT INTO catalogue (org_id, sku, name, unit, price_cents, cost_cents, source) VALUES (?,?,?,?,?,?,?)",
  );
  for (const row of DEFAULT_CATALOGUE) cat.run(org, ...row);

  const t = d.prepare("INSERT INTO templates (org_id, name, kind, fields) VALUES (?,?,?,?)");
  for (const row of DEFAULT_TEMPLATES) t.run(org, ...row);

  // Proposal on the hail-claim job, built from its measurement.
  const p = d.prepare(
    `INSERT INTO proposals (org_id, job_id, name, status, total_cents, cost_cents, sent_at, viewed_at, signed_at)
     VALUES (?,?,?,?,?,?, datetime('now','-6 days'), datetime('now','-5 days'), datetime('now','-4 days'))`,
  );
  const p1 = Number(p.run(org, jobIds[0], "Full roof replacement — 32.4 sq", "Signed", 1849900, 1108000).lastInsertRowid);
  const pl = d.prepare(
    "INSERT INTO proposal_lines (org_id, proposal_id, sku, name, unit, qty, unit_price_cents, unit_cost_cents) VALUES (?,?,?,?,?,?,?,?)",
  );
  for (const row of [
    ["GAF-TIMB-HDZ-CH", "GAF Timberline HDZ — Charcoal", "square", 36.3, 12550, 8100],
    ["SYN-FELT-10SQ", "Synthetic Underlayment 10SQ", "roll", 4, 9200, 6000],
    ["ICE-WATER-2SQ", "Ice & Water Shield 2SQ", "roll", 3, 11400, 7400],
    ["GAF-SEALAR-RIDGE", "GAF Seal-A-Ridge Cap Shingles", "bundle", 6, 7850, 5100],
    ["DRIP-F5-WHT-10", "Drip Edge F5 White 10ft", "piece", 25, 1180, 760],
    ["LAB-TEAROFF", "Labor — tear-off per square", "square", 32.4, 5500, 3800],
    ["LAB-INSTALL", "Labor — install per square", "square", 32.4, 8500, 5900],
    ["DUMP-30YD", "Dumpster — 30 yard", "each", 1, 52500, 41000],
  ] as Array<[string, string, string, number, number, number]>) {
    pl.run(org, p1, ...row);
  }
  d.prepare(
    "INSERT INTO proposals (org_id, job_id, name, status, total_cents, cost_cents, sent_at) VALUES (?,?,?,?,?,?, datetime('now','-2 days'))",
  ).run(org, jobIds[3], "New-build package — 4 lots", "Sent", 6420000, 4180000);
  d.prepare("INSERT INTO proposals (org_id, job_id, name, status, total_cents, cost_cents) VALUES (?,?,?,?,?,?)").run(
    org, jobIds[1], "Driveway extension — 640 sq ft", "Draft", 782500, 501000,
  );

  const doc = d.prepare(
    "INSERT INTO documents (org_id, job_id, template_id, name, status, signer, signed_at) VALUES (?,?,?,?,?,?,?)",
  );
  const tplId = (name: string) =>
    (d.prepare("SELECT id FROM templates WHERE org_id = ? AND name = ?").get(org, name) as { id: number }).id;
  doc.run(org, jobIds[0], tplId("Roofing contract (TX)"), "Roofing contract — Pamella", "Signed", "Luc Pamella", "2026-08-02 14:22:00");
  doc.run(org, jobIds[6], tplId("Certificate of Completion"), "Certificate of Completion — Ortega", "Signed", "Aaron Ortega", "2026-07-29 10:05:00");
  doc.run(org, jobIds[2], tplId("Roofing contract (TX)"), "Roofing contract — Brigg", "Sent", null, null);

  const mo = d.prepare(
    "INSERT INTO material_orders (org_id, job_id, proposal_id, supplier, status, total_cents, deliver_on) VALUES (?,?,?,?,?,?,?)",
  );
  mo.run(org, jobIds[0], p1, "SRS Roof Hub", "Ordered", 742300, "2026-08-11");
  mo.run(org, jobIds[2], null, "SRS Roof Hub", "Pending approval", 214500, "2026-08-14");

  const wo = d.prepare(
    "INSERT INTO work_orders (org_id, job_id, trade, crew, scheduled_for, status, amount_cents, notes) VALUES (?,?,?,?,?,?,?,?)",
  );
  wo.run(org, jobIds[0], "Roofing", "Ruiz Framing Co.", "2026-08-12", "Accepted", 486000, "Tear-off + install, 2-day");
  wo.run(org, jobIds[2], "Carpentry", "Ruiz Framing Co.", "2026-08-15", "Sent", 312000, "Pergola framing");
  wo.run(org, jobIds[4], "Roofing", "In-house crew", "2026-08-08", "Draft", 96000, "Half-day repair");

  const inv = d.prepare(
    "INSERT INTO invoices (org_id, job_id, kind, amount_cents, status, due_on, sent_at, paid_at) VALUES (?,?,?,?,?,?,?,?)",
  );
  const inv1 = Number(inv.run(org, jobIds[0], "Deposit", 924950, "Paid", "2026-08-03", "2026-08-02 15:00:00", "2026-08-02 16:41:00").lastInsertRowid);
  inv.run(org, jobIds[0], "Balance", 924950, "Draft", "2026-08-19", null, null);
  const inv3 = Number(inv.run(org, jobIds[6], "Deposit", 1105000, "Paid", "2026-07-15", "2026-07-14 09:00:00", "2026-07-14 12:12:00").lastInsertRowid);
  inv.run(org, jobIds[6], "Balance", 1105000, "Sent", "2026-08-11", "2026-07-29 11:00:00", null);
  const inv5 = Number(inv.run(org, jobIds[7], "Balance", 780000, "Paid", "2026-07-25", "2026-07-21 09:00:00", "2026-07-24 08:30:00").lastInsertRowid);

  const pay = d.prepare(
    "INSERT INTO payments (org_id, invoice_id, amount_cents, method, reference, received_at) VALUES (?,?,?,?,?,?)",
  );
  pay.run(org, inv1, 924950, "Card", "ch_3Qk2…8Xa", "2026-08-02 16:41:00");
  pay.run(org, inv3, 1105000, "ACH", "po_1Nf9…22B", "2026-07-14 12:12:00");
  pay.run(org, inv5, 780000, "Check", "#1841", "2026-07-24 08:30:00");

  const task = d.prepare(
    "INSERT INTO tasks (org_id, job_id, assignee_id, title, due_on, done) VALUES (?,?,?,?,?,?)",
  );
  task.run(org, jobIds[3], userIds[3], "Send per-lot pricing breakdown to Birdseye", "2026-08-06", 0);
  task.run(org, jobIds[8], userIds[2], "Book storm inspection window with Nancy", "2026-08-06", 0);
  task.run(org, jobIds[0], userIds[2], "Confirm dumpster drop for the 11th", "2026-08-07", 0);
  task.run(org, jobIds[6], userIds[2], "Chase balance invoice — 8 days out", "2026-08-08", 0);
  task.run(org, jobIds[9], userIds[3], "Gutter lead has sat 19 days — call or close", "2026-08-05", 0);
  task.run(org, jobIds[4], userIds[2], "Order shingles for Cordova Cove repair", "2026-08-05", 1);

  const auto = d.prepare(
    "INSERT INTO automations (org_id, name, trigger, action, channel, enabled, runs) VALUES (?,?,?,?,?,?,?)",
  );
  const runs = [34, 12, 27, 61, 0];
  DEFAULT_AUTOMATIONS.forEach(([name, trigger, action, channel, enabled], i) => {
    auto.run(org, name, trigger, action, channel, enabled, runs[i] ?? 0);
  });
}
