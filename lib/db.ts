// Demo persistence: node:sqlite (Node >= 22, zero native deps — matters
// because our npm hardening disables install scripts). Schema + seed run
// idempotently at first touch. Phase 2 swaps this module for the AMOS
// managed Postgres the platform injects via secrets — the query surface
// below is deliberately tiny to keep that swap mechanical.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";

let db: DatabaseSync | null = null;

export const STAGES = [
  "Lead",
  "Prospect",
  "Approved",
  "Scheduled",
  "Completed/Invoiced",
  "Ready for Commission",
  "Closed",
] as const;
export type Stage = (typeof STAGES)[number];

export function getDb(): DatabaseSync {
  if (db) return db;
  mkdirSync("data", { recursive: true });
  db = new DatabaseSync("data/roofline.db");
  db.exec(`
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
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      phone TEXT, email TEXT, address TEXT
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      contact_id INTEGER REFERENCES contacts(id),
      address TEXT NOT NULL,
      trade TEXT NOT NULL,
      source TEXT NOT NULL,
      stage TEXT NOT NULL DEFAULT 'Lead',
      assignee_id INTEGER REFERENCES users(id),
      value_cents INTEGER NOT NULL DEFAULT 0,
      deposit_paid INTEGER NOT NULL DEFAULT 0,
      scheduled_for TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS job_events (
      id INTEGER PRIMARY KEY,
      job_id INTEGER NOT NULL REFERENCES jobs(id),
      kind TEXT NOT NULL,             -- note | email | stage | system
      body TEXT NOT NULL,
      actor TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS measurements (
      id INTEGER PRIMARY KEY,
      job_id INTEGER NOT NULL REFERENCES jobs(id),
      provider TEXT NOT NULL,          -- gaf_quickmeasure | eagleview | solar_estimate
      status TEXT NOT NULL,            -- ordered | delivered
      total_squares REAL,
      ridge_ft REAL, hip_ft REAL, valley_ft REAL, eave_ft REAL, rake_ft REAL,
      pitch TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS catalogue (
      id INTEGER PRIMARY KEY,
      sku TEXT NOT NULL,
      name TEXT NOT NULL,
      unit TEXT NOT NULL,
      price_cents INTEGER NOT NULL,
      source TEXT NOT NULL DEFAULT 'custom'  -- srs_roofhub | custom
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  seed(db);
  return db;
}

function seed(d: DatabaseSync) {
  const users = d.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number };
  if (users.n > 0) return;

  const insUser = d.prepare(
    "INSERT INTO users (email, name, role, manager_id, password) VALUES (?,?,?,?,?)",
  );
  insUser.run("jeff@demo.roofline", "Jeff Barnes", "admin", null, "demo2026");
  insUser.run("dana@demo.roofline", "Dana Whitfield", "manager", 1, "demo2026");
  insUser.run("marcus@demo.roofline", "Marcus Lee", "rep", 2, "demo2026");
  insUser.run("priya@demo.roofline", "Priya Nair", "rep", 2, "demo2026");

  const insContact = d.prepare(
    "INSERT INTO contacts (name, type, phone, email, address) VALUES (?,?,?,?,?)",
  );
  const contacts: Array<[string, string, string, string, string]> = [
    ["Luc Pamella", "Homeowner", "(512) 555-0173", "luc.p@example.com", "3869 Dover Ferry Crossing, Austin, TX"],
    ["April Duley", "Homeowner", "(512) 555-0114", "april.d@example.com", "113 Flycatcher Cove, Cedar Creek, TX"],
    ["Paul Brigg", "Homeowner", "(512) 555-0147", "paul.b@example.com", "2409 Chimney Rock Road, Leander, TX"],
    ["Birdseye Builders", "Builder", "(512) 555-0190", "office@birdseye.example.com", "1709 Manans Street, Austin, TX"],
    ["Aaron Ortega", "Homeowner", "(512) 555-0166", "aaron.o@example.com", "1335 Cordova Cove, Cedar Park, TX"],
    ["Sandra Kim (State Farm)", "Insurance Agent", "(512) 555-0122", "s.kim@example.com", "Austin, TX"],
    ["Cleo Barrera", "Homeowner", "(512) 555-0158", "cleo.b@example.com", "610 Broad Street, Buda, TX"],
  ];
  for (const c of contacts) insContact.run(...c);

  const insJob = d.prepare(
    `INSERT INTO jobs (title, contact_id, address, trade, source, stage, assignee_id, value_cents, deposit_paid, scheduled_for)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  );
  const jobs: Array<[string, number, string, string, string, Stage, number, number, number, string | null]> = [
    ["Roof replacement — hail claim", 1, "3869 Dover Ferry Crossing, Austin, TX", "Roofing", "Insurance referral", "Approved", 3, 1849900, 1, "2026-08-12"],
    ["Driveway extension", 2, "113 Flycatcher Cove, Cedar Creek, TX", "Concrete", "Door knocking", "Prospect", 3, 782500, 0, null],
    ["Pergola build", 3, "2409 Chimney Rock Road, Leander, TX", "Carpentry", "Referral", "Approved", 4, 1779000, 1, "2026-08-15"],
    ["New-build roofing package (4 lots)", 4, "1709 Manans Street, Austin, TX", "Roofing", "Builder relationship", "Prospect", 4, 6420000, 0, null],
    ["Shingle repair after wind event", 5, "1335 Cordova Cove, Cedar Park, TX", "Roofing", "Office call", "Scheduled", 3, 485000, 1, "2026-08-08"],
    ["Full re-roof + gutters", 7, "610 Broad Street, Buda, TX", "Roofing", "QR instant estimate", "Lead", 4, 0, 0, null],
    ["Metal roof quote", 5, "97 County Road 200, Burnet, TX", "Roofing", "Networking", "Completed/Invoiced", 3, 2210000, 1, "2026-07-28"],
    ["Bathroom remodel", 2, "21307 Byerly Turk Drive, Pflugerville, TX", "Remodel", "Repeat customer", "Ready for Commission", 4, 1560000, 1, "2026-07-20"],
  ];
  for (const j of jobs) insJob.run(...j);

  const insEvent = d.prepare(
    "INSERT INTO job_events (job_id, kind, body, actor) VALUES (?,?,?,?)",
  );
  insEvent.run(1, "system", "Lead created from insurance referral (Sandra Kim, State Farm)", "system");
  insEvent.run(1, "email", "Sent proposal PDF to luc.p@example.com — viewed 2x", "Marcus Lee");
  insEvent.run(1, "stage", "Contract signed via PDF Signer → moved to Approved; 50% deposit link paid", "Marcus Lee");
  insEvent.run(5, "note", "Homeowner prefers install after 9am; dogs in backyard", "Marcus Lee");
  insEvent.run(3, "email", "Sub crew (framing) confirmed for the 15th", "Priya Nair");

  const insMeas = d.prepare(
    `INSERT INTO measurements (job_id, provider, status, total_squares, ridge_ft, hip_ft, valley_ft, eave_ft, rake_ft, pitch)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  );
  insMeas.run(1, "gaf_quickmeasure", "delivered", 32.4, 64, 38, 41, 152, 96, "6/12");
  insMeas.run(6, "solar_estimate", "delivered", 28.1, null, null, null, null, null, "5/12 (est)");
  insMeas.run(7, "eagleview", "delivered", 41.7, 88, 12, 56, 178, 104, "8/12");

  const insCat = d.prepare(
    "INSERT INTO catalogue (sku, name, unit, price_cents, source) VALUES (?,?,?,?,?)",
  );
  const cat: Array<[string, string, string, number, string]> = [
    ["GAF-TIMB-HDZ-CH", "GAF Timberline HDZ — Charcoal", "square", 12550, "srs_roofhub"],
    ["GAF-PROSTART-120", "GAF ProStart Starter Strip", "bundle", 6725, "srs_roofhub"],
    ["GAF-SEALAR-RIDGE", "GAF Seal-A-Ridge Cap Shingles", "bundle", 7850, "srs_roofhub"],
    ["SYN-FELT-10SQ", "Synthetic Underlayment 10SQ", "roll", 9200, "srs_roofhub"],
    ["DRIP-F5-WHT-10", 'Drip Edge F5 White 10ft', "piece", 1180, "srs_roofhub"],
    ["ICE-WATER-2SQ", "Ice & Water Shield 2SQ", "roll", 11400, "srs_roofhub"],
    ["LAB-TEAROFF", "Labor — tear-off per square", "square", 5500, "custom"],
    ["LAB-INSTALL", "Labor — install per square", "square", 8500, "custom"],
  ];
  for (const c of cat) insCat.run(...c);

  d.prepare("INSERT INTO settings (key, value) VALUES (?,?)").run(
    "srs_roofhub_key",
    "",
  );
}
