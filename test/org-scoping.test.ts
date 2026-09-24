/**
 * Org scoping against a REAL Postgres: rows inserted for org A must never
 * come back from org-B-scoped queries (and vice versa). Runs against
 * ROOFLINE_TEST_DATABASE_URL, defaulting to postgres://localhost:5432/roofline_test
 * (the database is created if the server is reachable); skips with a clear
 * message when no local Postgres is available.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

const TEST_URL =
  process.env.ROOFLINE_TEST_DATABASE_URL ?? "postgres://localhost:5432/roofline_test";

async function ensureTestDb(): Promise<boolean> {
  const url = new URL(TEST_URL);
  const dbName = url.pathname.slice(1) || "roofline_test";
  const maint = new URL(TEST_URL);
  maint.pathname = "/postgres";
  const client = new Client({ connectionString: maint.href });
  try {
    await client.connect();
  } catch {
    return false;
  }
  try {
    const exists = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [dbName]);
    if (exists.rowCount === 0) await client.query(`CREATE DATABASE "${dbName}"`);
    return true;
  } finally {
    await client.end();
  }
}

test("org scoping against real Postgres", async (t) => {
  if (!(await ensureTestDb())) {
    t.skip(
      `Postgres not reachable at ${TEST_URL} — start a local server or set ROOFLINE_TEST_DATABASE_URL`,
    );
    return;
  }
  process.env.DATABASE_URL = TEST_URL;
  const { getDb, closeDb } = await import("../lib/db.ts");
  const db = getDb();
  t.after(async () => closeDb());

  // Clean slate (also proves migrations ran and created every table).
  await db.run(
    `TRUNCATE job_events, payments, invoices, tasks, work_orders, material_orders,
     documents, proposal_lines, proposals, measurements, catalogue, templates,
     automations, jobs, contacts, users, orgs RESTART IDENTITY CASCADE`,
  );

  const orgA = randomUUID();
  const orgB = randomUUID();
  await db.run("INSERT INTO orgs (id, name, amos_tenant_id) VALUES (?,?,?)", orgA, "Org A", randomUUID());
  await db.run("INSERT INTO orgs (id, name, amos_tenant_id) VALUES (?,?,?)", orgB, "Org B", randomUUID());

  const userA = await db.run(
    "INSERT INTO users (org_id, email, name, role) VALUES (?,?,?,?)",
    orgA, "a@a.test", "Alice", "admin",
  );
  const userB = await db.run(
    "INSERT INTO users (org_id, email, name, role) VALUES (?,?,?,?)",
    orgB, "b@b.test", "Bob", "admin",
  );

  const jobA = await db.run(
    `INSERT INTO jobs (org_id, title, address, trade, source, stage, assignee_id, value_cents)
     VALUES (?,?,?,?,?,?,?,?)`,
    orgA, "A-only roof", "1 A St", "Roofing", "Referral", "Approved", userA.lastId, 100_00,
  );
  await db.run(
    `INSERT INTO jobs (org_id, title, address, trade, source, stage, assignee_id, value_cents)
     VALUES (?,?,?,?,?,?,?,?)`,
    orgB, "B-only roof", "1 B St", "Roofing", "Referral", "Approved", userB.lastId, 200_00,
  );

  await t.test("list query returns only the scoped org's jobs", async () => {
    const rows = await db.all<{ id: number; title: string }>(
      `SELECT j.id, j.title FROM jobs j
       LEFT JOIN users u ON u.id = j.assignee_id
       WHERE j.org_id = ? ORDER BY j.updated_at DESC`,
      orgA,
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].title, "A-only roof");
    assert.ok(!rows.some((r) => r.title.startsWith("B-only")));
  });

  await t.test("point lookup with the wrong org finds nothing", async () => {
    const cross = await db.get(
      "SELECT id FROM jobs WHERE id = ? AND org_id = ?",
      jobA.lastId, orgB,
    );
    assert.equal(cross, undefined);
    const same = await db.get<{ id: number }>(
      "SELECT id FROM jobs WHERE id = ? AND org_id = ?",
      jobA.lastId, orgA,
    );
    assert.equal(same?.id, jobA.lastId);
  });

  await t.test("aggregates only count the scoped org", async () => {
    const agg = await db.all<{ stage: string; jobs: number; value_cents: number }>(
      "SELECT stage, COUNT(*) AS jobs, COALESCE(SUM(value_cents),0) AS value_cents FROM jobs WHERE org_id = ? GROUP BY stage",
      orgB,
    );
    assert.equal(agg.length, 1);
    assert.equal(agg[0].jobs, 1); // number, not "1" — int8 parser at work
    assert.equal(agg[0].value_cents, 200_00);
  });

  await t.test("sqlite-dialect datetime()/date() translate on Postgres", async () => {
    const inv = await db.run(
      "INSERT INTO invoices (org_id, job_id, kind, amount_cents, status, due_on, sent_at) VALUES (?,?,?,?, 'Sent', date('now','+14 days'), datetime('now'))",
      orgA, jobA.lastId, "Deposit", 50_00,
    );
    const row = await db.get<{ due_on: string; sent_at: string }>(
      "SELECT due_on, sent_at FROM invoices WHERE id = ? AND org_id = ?",
      inv.lastId, orgA,
    );
    assert.match(row!.due_on, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(row!.sent_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    // The org-B invoice list must not see it.
    const forB = await db.all("SELECT id FROM invoices WHERE org_id = ?", orgB);
    assert.equal(forB.length, 0);
  });
});
