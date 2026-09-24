// Local demo keeps node:sqlite. Production sets DATABASE_URL (the platform
// already injects the managed Postgres URL) and every page goes through that.
// Existing rows are left in place: a database that already has users is not
// reseeded. Schema + the demo seed run only on an empty database.
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { execScript, queryRaw, statement } from "./pg-sync";
import { postgresSchema, sequenceBumpSql, translateSql } from "./sql-compat.mjs";

interface SqlDatabase {
  prepare(sql: string): {
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
    run(...args: unknown[]): { lastInsertRowid: number; changes: number };
  };
  exec(sql: string): void;
}

let db: SqlDatabase | null = null;

/** Pipeline stages, per 8 Square's live board (assignment is its own stage). */
export const STAGES = [
  "New lead",
  "Assigned lead",
  "Prospect",
  "Approved",
  "Scheduled",
  "Completed/Invoiced",
  "Ready for Commission",
  "Closed",
] as const;
export type Stage = (typeof STAGES)[number];

/** Jobs belong to a workflow; a company runs several (roofing, construction…). */
export const WORKFLOWS = ["Roofing", "Construction", "Service"] as const;

export const COMMISSION_RATE = 0.1;

const SCHEMA = `
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin','manager','rep')),
      manager_id INTEGER REFERENCES users(id),
      password TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS contacts (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL, type TEXT NOT NULL,
      phone TEXT, email TEXT, address TEXT
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY,
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
      job_id INTEGER NOT NULL REFERENCES jobs(id),
      kind TEXT NOT NULL, body TEXT NOT NULL, actor TEXT NOT NULL,
      direction TEXT NOT NULL DEFAULT 'internal',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS measurements (
      id INTEGER PRIMARY KEY,
      job_id INTEGER NOT NULL REFERENCES jobs(id),
      provider TEXT NOT NULL, status TEXT NOT NULL,
      total_squares REAL,
      ridge_ft REAL, hip_ft REAL, valley_ft REAL, eave_ft REAL, rake_ft REAL,
      pitch TEXT, waste_pct REAL DEFAULT 12,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS catalogue (
      id INTEGER PRIMARY KEY,
      sku TEXT NOT NULL, name TEXT NOT NULL, unit TEXT NOT NULL,
      price_cents INTEGER NOT NULL, cost_cents INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'custom'
    );
    CREATE TABLE IF NOT EXISTS proposals (
      id INTEGER PRIMARY KEY,
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
      proposal_id INTEGER NOT NULL REFERENCES proposals(id),
      sku TEXT NOT NULL, name TEXT NOT NULL, unit TEXT NOT NULL,
      qty REAL NOT NULL, unit_price_cents INTEGER NOT NULL,
      unit_cost_cents INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS templates (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,        -- contract|coc|change_order|warranty|proposal
      fields TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY,
      job_id INTEGER NOT NULL REFERENCES jobs(id),
      template_id INTEGER REFERENCES templates(id),
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'Draft',   -- Draft|Sent|Signed
      signer TEXT, signed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS material_orders (
      id INTEGER PRIMARY KEY,
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
      job_id INTEGER NOT NULL REFERENCES jobs(id),
      kind TEXT NOT NULL,                     -- Deposit|Balance|Change order
      amount_cents INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'Draft',   -- Draft|Sent|Paid|Overdue
      due_on TEXT, sent_at TEXT, paid_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY,
      invoice_id INTEGER NOT NULL REFERENCES invoices(id),
      amount_cents INTEGER NOT NULL,
      method TEXT NOT NULL DEFAULT 'Card',
      reference TEXT,
      received_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY,
      job_id INTEGER REFERENCES jobs(id),
      assignee_id INTEGER REFERENCES users(id),
      title TEXT NOT NULL, due_on TEXT,
      done INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS automations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL, trigger TEXT NOT NULL, action TEXT NOT NULL,
      channel TEXT NOT NULL DEFAULT 'email',
      enabled INTEGER NOT NULL DEFAULT 1,
      runs INTEGER NOT NULL DEFAULT 0
    );
`;

function openSqlite(): SqlDatabase {
  mkdirSync("data", { recursive: true });
  const sqlite = new DatabaseSync("data/roofline.db");
  sqlite.exec(SCHEMA);
  return sqlite as unknown as SqlDatabase;
}

function openPostgres(): SqlDatabase {
  execScript("SELECT pg_advisory_lock(2147483001)");
  try {
    execScript(postgresSchema(SCHEMA));
    const loaded = queryRaw(
      `SELECT (
         (SELECT COUNT(*) FROM users) +
         (SELECT COUNT(*) FROM contacts) +
         (SELECT COUNT(*) FROM jobs)
       )::int AS n`,
    ).rows?.[0]?.n;
    if (Number(loaded) > 0) {
      execScript(sequenceBumpSql());
      return { prepare: statement, exec: execScript };
    }
    const sqlitePath = "data/roofline.db";
    if (existsSync(sqlitePath)) {
      copySqlite(sqlitePath);
    }
    const after = queryRaw("SELECT COUNT(*)::int AS n FROM users").rows?.[0]?.n;
    if (Number(after) === 0) {
      seed({ prepare: statement, exec: execScript });
    }
    execScript(sequenceBumpSql());
    return { prepare: statement, exec: execScript };
  } finally {
    execScript("SELECT pg_advisory_unlock(2147483001)");
  }
}

function copySqlite(path: string): void {
  const source = new DatabaseSync(path, { readOnly: true });
  const tables = [
    "users",
    "contacts",
    "jobs",
    "job_events",
    "measurements",
    "catalogue",
    "proposals",
    "proposal_lines",
    "templates",
    "documents",
    "material_orders",
    "work_orders",
    "invoices",
    "payments",
    "tasks",
    "automations",
  ];
  execScript("BEGIN");
  try {
    for (const table of tables) {
      const rows = source.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>;
      for (const row of rows) {
        const keys = Object.keys(row);
        queryRaw(
          translateSql(
            `INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`,
          ),
          keys.map((key) => row[key]),
        );
      }
    }
    execScript("COMMIT");
  } catch (error) {
    execScript("ROLLBACK");
    throw error;
  }
}

export function getDb(): SqlDatabase {
  if (db) return db;
  db = process.env.DATABASE_URL ? openPostgres() : openSqlite();
  if (!process.env.DATABASE_URL) seed(db);
  return db;
}

function seed(d: SqlDatabase) {
  const n = d.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number };
  if (n.n > 0) return;

  const u = d.prepare(
    "INSERT INTO users (email, name, role, manager_id, password) VALUES (?,?,?,?,?)",
  );
  u.run("jeff@demo.roofline", "Jeff Barnes", "admin", null, "demo2026");
  u.run("dana@demo.roofline", "Dana Whitfield", "manager", 1, "demo2026");
  u.run("marcus@demo.roofline", "Marcus Lee", "rep", 2, "demo2026");
  u.run("priya@demo.roofline", "Priya Nair", "rep", 2, "demo2026");

  const c = d.prepare(
    "INSERT INTO contacts (name, type, phone, email, address) VALUES (?,?,?,?,?)",
  );
  for (const row of [
    ["Luc Pamella", "Homeowner", "(512) 555-0173", "luc.p@example.com", "3869 Dover Ferry Crossing, Austin, TX"],
    ["April Duley", "Homeowner", "(512) 555-0114", "april.d@example.com", "113 Flycatcher Cove, Cedar Creek, TX"],
    ["Paul Brigg", "Homeowner", "(512) 555-0147", "paul.b@example.com", "2409 Chimney Rock Road, Leander, TX"],
    ["Birdseye Builders", "Builder", "(512) 555-0190", "office@birdseye.example.com", "1709 Manans Street, Austin, TX"],
    ["Aaron Ortega", "Homeowner", "(512) 555-0166", "aaron.o@example.com", "1335 Cordova Cove, Cedar Park, TX"],
    ["Sandra Kim (State Farm)", "Insurance Agent", "(512) 555-0122", "s.kim@example.com", "Austin, TX"],
    ["Cleo Barrera", "Homeowner", "(512) 555-0158", "cleo.b@example.com", "610 Broad Street, Buda, TX"],
    ["Ruiz Framing Co.", "Crew lead", "(512) 555-0181", "ruiz@example.com", "Austin, TX"],
    ["Nancy Iverson", "Homeowner", "(512) 555-0135", "nancy.i@example.com", "88 Lakeway Drive, Lakeway, TX"],
  ] as Array<[string, string, string, string, string]>) {
    c.run(...row);
  }

  const j = d.prepare(
    `INSERT INTO jobs (title, contact_id, address, trade, workflow, source, stage, assignee_id,
                       value_cents, cost_cents, scheduled_for, stage_since)
     VALUES (?,?,?,?,?,?,?,?,?,?,?, datetime('now', ?))`,
  );
  const jobs: Array<[string, number, string, string, string, string, Stage, number, number, number, string | null, string]> = [
    ["Roof replacement — hail claim", 1, "3869 Dover Ferry Crossing, Austin, TX", "Roofing", "Roofing", "Insurance referral", "Approved", 3, 1849900, 1108000, "2026-08-12", "-3 days"],
    ["Driveway extension", 2, "113 Flycatcher Cove, Cedar Creek, TX", "Concrete", "Construction", "Door knocking", "Prospect", 3, 782500, 501000, null, "-8 days"],
    ["Pergola build", 3, "2409 Chimney Rock Road, Leander, TX", "Carpentry", "Construction", "Referral", "Approved", 4, 1779000, 1090000, "2026-08-15", "-2 days"],
    ["New-build roofing package (4 lots)", 4, "1709 Manans Street, Austin, TX", "Roofing", "Roofing", "Builder relationship", "Prospect", 4, 6420000, 4180000, null, "-21 days"],
    ["Shingle repair after wind event", 5, "1335 Cordova Cove, Cedar Park, TX", "Roofing", "Service", "Office call", "Scheduled", 3, 485000, 262000, "2026-08-08", "-1 days"],
    ["Full re-roof + gutters", 7, "610 Broad Street, Buda, TX", "Roofing", "Roofing", "QR instant estimate", "New lead", 4, 0, 0, null, "-1 days"],
    ["Metal roof quote", 5, "97 County Road 200, Burnet, TX", "Roofing", "Roofing", "Networking", "Completed/Invoiced", 3, 2210000, 1402000, "2026-07-28", "-6 days"],
    ["Bathroom remodel", 2, "21307 Byerly Turk Drive, Pflugerville, TX", "Remodel", "Construction", "Repeat customer", "Ready for Commission", 4, 1560000, 967000, "2026-07-20", "-11 days"],
    ["Storm damage inspection", 9, "88 Lakeway Drive, Lakeway, TX", "Roofing", "Roofing", "Door knocking", "Assigned lead", 3, 0, 0, null, "-4 days"],
    ["Gutter replacement", 9, "88 Lakeway Drive, Lakeway, TX", "Gutters", "Service", "Referral", "Assigned lead", 4, 0, 0, null, "-19 days"],
    ["Commercial flat roof — retail strip", 4, "1200 Braker Lane, Austin, TX", "Roofing", "Roofing", "Networking", "New lead", 3, 0, 0, null, "-2 days"],
    ["Fascia + soffit repair", 7, "610 Broad Street, Buda, TX", "Carpentry", "Service", "Repeat customer", "Closed", 4, 342000, 208000, "2026-07-02", "-30 days"],
  ];
  for (const row of jobs) j.run(...row);

  const e = d.prepare(
    "INSERT INTO job_events (job_id, kind, body, actor, direction) VALUES (?,?,?,?,?)",
  );
  e.run(1, "system", "Lead created from insurance referral (Sandra Kim, State Farm)", "system", "internal");
  e.run(1, "email", "Sent proposal PDF to luc.p@example.com — viewed 2x", "Marcus Lee", "outbound");
  e.run(1, "email", "Homeowner: 'Looks good, when can you start?'", "Luc Pamella", "inbound");
  e.run(1, "stage", "Contract signed via PDF Signer → Approved; 50% deposit paid", "Marcus Lee", "internal");
  e.run(5, "note", "Homeowner prefers install after 9am; dogs in backyard", "Marcus Lee", "internal");
  e.run(3, "email", "Sub crew (framing) confirmed for the 15th", "Priya Nair", "outbound");
  e.run(9, "sms", "Texted homeowner to schedule the inspection window", "Marcus Lee", "outbound");
  e.run(4, "email", "Builder asked for per-lot pricing breakdown", "Birdseye Builders", "inbound");

  const m = d.prepare(
    `INSERT INTO measurements (job_id, provider, status, total_squares, ridge_ft, hip_ft, valley_ft, eave_ft, rake_ft, pitch)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  );
  m.run(1, "gaf_quickmeasure", "delivered", 32.4, 64, 38, 41, 152, 96, "6/12");
  m.run(6, "solar_estimate", "delivered", 28.1, null, null, null, null, null, "5/12 (est)");
  m.run(7, "eagleview", "delivered", 41.7, 88, 12, 56, 178, 104, "8/12");
  m.run(11, "eagleview", "ordered", null, null, null, null, null, null, null);

  const cat = d.prepare(
    "INSERT INTO catalogue (sku, name, unit, price_cents, cost_cents, source) VALUES (?,?,?,?,?,?)",
  );
  for (const row of [
    ["GAF-TIMB-HDZ-CH", "GAF Timberline HDZ — Charcoal", "square", 12550, 8100, "srs_roofhub"],
    ["GAF-PROSTART-120", "GAF ProStart Starter Strip", "bundle", 6725, 4400, "srs_roofhub"],
    ["GAF-SEALAR-RIDGE", "GAF Seal-A-Ridge Cap Shingles", "bundle", 7850, 5100, "srs_roofhub"],
    ["SYN-FELT-10SQ", "Synthetic Underlayment 10SQ", "roll", 9200, 6000, "srs_roofhub"],
    ["DRIP-F5-WHT-10", "Drip Edge F5 White 10ft", "piece", 1180, 760, "srs_roofhub"],
    ["ICE-WATER-2SQ", "Ice & Water Shield 2SQ", "roll", 11400, 7400, "srs_roofhub"],
    ["VENT-RIDGE-4", "Ridge Vent 4ft section", "piece", 2250, 1450, "srs_roofhub"],
    ["NAIL-COIL-1.25", "Roofing nails, coil 1-1/4\"", "box", 6400, 4100, "srs_roofhub"],
    ["LAB-TEAROFF", "Labor — tear-off per square", "square", 5500, 3800, "custom"],
    ["LAB-INSTALL", "Labor — install per square", "square", 8500, 5900, "custom"],
    ["DUMP-30YD", "Dumpster — 30 yard", "each", 52500, 41000, "custom"],
  ] as Array<[string, string, string, number, number, string]>) {
    cat.run(...row);
  }

  const t = d.prepare("INSERT INTO templates (name, kind, fields) VALUES (?,?,?)");
  t.run("Roofing contract (TX)", "contract", "homeowner, address, scope, total, deposit");
  t.run("Certificate of Completion", "coc", "homeowner, address, completion_date");
  t.run("Change order", "change_order", "homeowner, description, delta");
  t.run("Workmanship warranty", "warranty", "homeowner, address, years");
  t.run("Standard roofing proposal", "proposal", "line items, measurement, total");

  // Proposal on the hail-claim job, built from its measurement.
  const p = d.prepare(
    `INSERT INTO proposals (job_id, name, status, total_cents, cost_cents, sent_at, viewed_at, signed_at)
     VALUES (?,?,?,?,?, datetime('now','-6 days'), datetime('now','-5 days'), datetime('now','-4 days'))`,
  );
  p.run(1, "Full roof replacement — 32.4 sq", "Signed", 1849900, 1108000);
  const pl = d.prepare(
    "INSERT INTO proposal_lines (proposal_id, sku, name, unit, qty, unit_price_cents, unit_cost_cents) VALUES (?,?,?,?,?,?,?)",
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
    pl.run(1, ...row);
  }
  const p2 = d.prepare(
    "INSERT INTO proposals (job_id, name, status, total_cents, cost_cents, sent_at) VALUES (?,?,?,?,?, datetime('now','-2 days'))",
  );
  p2.run(4, "New-build package — 4 lots", "Sent", 6420000, 4180000);
  d.prepare("INSERT INTO proposals (job_id, name, status, total_cents, cost_cents) VALUES (?,?,?,?,?)").run(
    2, "Driveway extension — 640 sq ft", "Draft", 782500, 501000,
  );

  const doc = d.prepare(
    "INSERT INTO documents (job_id, template_id, name, status, signer, signed_at) VALUES (?,?,?,?,?,?)",
  );
  doc.run(1, 1, "Roofing contract — Pamella", "Signed", "Luc Pamella", "2026-08-02 14:22:00");
  doc.run(7, 2, "Certificate of Completion — Ortega", "Signed", "Aaron Ortega", "2026-07-29 10:05:00");
  doc.run(3, 1, "Roofing contract — Brigg", "Sent", null, null);

  const mo = d.prepare(
    "INSERT INTO material_orders (job_id, proposal_id, supplier, status, total_cents, deliver_on) VALUES (?,?,?,?,?,?)",
  );
  mo.run(1, 1, "SRS Roof Hub", "Ordered", 742300, "2026-08-11");
  mo.run(3, null, "SRS Roof Hub", "Pending approval", 214500, "2026-08-14");

  const wo = d.prepare(
    "INSERT INTO work_orders (job_id, trade, crew, scheduled_for, status, amount_cents, notes) VALUES (?,?,?,?,?,?,?)",
  );
  wo.run(1, "Roofing", "Ruiz Framing Co.", "2026-08-12", "Accepted", 486000, "Tear-off + install, 2-day");
  wo.run(3, "Carpentry", "Ruiz Framing Co.", "2026-08-15", "Sent", 312000, "Pergola framing");
  wo.run(5, "Roofing", "In-house crew", "2026-08-08", "Draft", 96000, "Half-day repair");

  const inv = d.prepare(
    "INSERT INTO invoices (job_id, kind, amount_cents, status, due_on, sent_at, paid_at) VALUES (?,?,?,?,?,?,?)",
  );
  inv.run(1, "Deposit", 924950, "Paid", "2026-08-03", "2026-08-02 15:00:00", "2026-08-02 16:41:00");
  inv.run(1, "Balance", 924950, "Draft", "2026-08-19", null, null);
  inv.run(7, "Deposit", 1105000, "Paid", "2026-07-15", "2026-07-14 09:00:00", "2026-07-14 12:12:00");
  inv.run(7, "Balance", 1105000, "Sent", "2026-08-11", "2026-07-29 11:00:00", null);
  inv.run(8, "Balance", 780000, "Paid", "2026-07-25", "2026-07-21 09:00:00", "2026-07-24 08:30:00");

  const pay = d.prepare(
    "INSERT INTO payments (invoice_id, amount_cents, method, reference, received_at) VALUES (?,?,?,?,?)",
  );
  pay.run(1, 924950, "Card", "ch_3Qk2…8Xa", "2026-08-02 16:41:00");
  pay.run(3, 1105000, "ACH", "po_1Nf9…22B", "2026-07-14 12:12:00");
  pay.run(5, 780000, "Check", "#1841", "2026-07-24 08:30:00");

  const task = d.prepare(
    "INSERT INTO tasks (job_id, assignee_id, title, due_on, done) VALUES (?,?,?,?,?)",
  );
  task.run(4, 4, "Send per-lot pricing breakdown to Birdseye", "2026-08-06", 0);
  task.run(9, 3, "Book storm inspection window with Nancy", "2026-08-06", 0);
  task.run(1, 3, "Confirm dumpster drop for the 11th", "2026-08-07", 0);
  task.run(7, 3, "Chase balance invoice — 8 days out", "2026-08-08", 0);
  task.run(10, 4, "Gutter lead has sat 19 days — call or close", "2026-08-05", 0);
  task.run(5, 3, "Order shingles for Cordova Cove repair", "2026-08-05", 1);

  const auto = d.prepare(
    "INSERT INTO automations (name, trigger, action, channel, enabled, runs) VALUES (?,?,?,?,?,?)",
  );
  auto.run("Install-day details", "Job scheduled", "Email homeowner install + delivery instructions", "email", 1, 34);
  auto.run("Deposit reminder", "Invoice unpaid 3 days", "Text homeowner the payment link", "sms", 1, 12);
  auto.run("Proposal follow-up", "Proposal sent, not viewed in 2 days", "Email rep to follow up", "email", 1, 27);
  auto.run("Stale lead nudge", "Lead in stage 14 days", "Task for the assigned rep", "task", 1, 61);
  auto.run("Post-job review request", "Job closed", "Email homeowner a review link", "email", 0, 0);
}
