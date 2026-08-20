/**
 * Snapshot importer: demo-row filtering, relationship rewiring, and
 * idempotency on re-run. Runs against a throwaway sqlite database so it
 * needs no services (the importer itself is backend-agnostic — the Postgres
 * path is the same code over the other adapter).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ROOFLINE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "roofline-import-")), "test.db");
delete process.env.DATABASE_URL;

const { getDb, closeDb } = await import("../lib/db.ts");
const { importSnapshot } = await import("../scripts/import-snapshot.ts");

const snapshot = {
  contacts: [
    { ref: "c1", name: "Harriet Boone", type: "Homeowner", phone: "(512) 555-9001", address: "12 Real St, Austin, TX" },
    // exact demo seed contact — must be filtered out
    { ref: "c2", name: "Luc Pamella", type: "Homeowner", address: "3869 Dover Ferry Crossing, Austin, TX" },
  ],
  jobs: [
    { ref: "j1", title: "Boone re-roof", contact_ref: "c1", address: "12 Real St, Austin, TX", stage: "Approved", value_cents: 900000 },
    // exact demo seed job title — must be filtered out
    { ref: "j2", title: "Pergola build", contact_ref: "c2", address: "2409 Chimney Rock Road, Leander, TX" },
  ],
  measurements: [
    { job_ref: "j1", provider: "gaf_quickmeasure", status: "delivered", total_squares: 24.5, ridge_ft: 60, eave_ft: 140, pitch: "6/12", created_at: "2026-08-01 09:00:00" },
    // measurement on the skipped demo job — must be skipped transitively
    { job_ref: "j2", provider: "eagleview", status: "delivered", total_squares: 30 },
  ],
  proposals: [
    { job_ref: "j1", name: "Boone proposal", status: "Signed", total_cents: 900000, lines: [
      { sku: "LAB-INSTALL", name: "Labor — install per square", unit: "square", qty: 20, unit_price_cents: 8500, unit_cost_cents: 5900 },
    ] },
    { job_ref: "j2", name: "Should be skipped with its job", total_cents: 1 },
  ],
  invoices: [
    { job_ref: "j1", kind: "Deposit", amount_cents: 450000, status: "Paid", payments: [
      { amount_cents: 450000, method: "ACH", reference: "po_test" },
    ] },
  ],
  tasks: [{ job_ref: "j1", title: "Order materials", due_on: "2026-09-01" }],
  events: [
    { job_ref: "j1", kind: "note", body: "Imported note", actor: "importer" },
    { job_ref: "missing", kind: "note", body: "Dangling", actor: "importer" },
  ],
};

test("import: demo filtering, relationships, idempotency", async (t) => {
  const db = getDb();
  t.after(async () => closeDb());

  const orgId = randomUUID();
  await db.run("INSERT INTO orgs (id, name, amos_tenant_id) VALUES (?,?,?)", orgId, "8 Square", randomUUID());
  const demoContactsBefore = (await db.all("SELECT id FROM contacts WHERE org_id != ?", orgId)).length;

  await t.test("first run inserts real rows and skips demo/dangling ones", async () => {
    const r = await importSnapshot(orgId, snapshot);
    assert.deepEqual(
      { inserted: r.contacts.inserted, demo: r.contacts.skippedDemo },
      { inserted: 1, demo: 1 },
    );
    assert.deepEqual({ inserted: r.jobs.inserted, demo: r.jobs.skippedDemo }, { inserted: 1, demo: 1 });
    assert.equal(r.measurements.inserted, 1);
    assert.equal(r.measurements.skippedDangling, 1); // measurement on the skipped demo job
    assert.equal(r.proposals.inserted, 1);
    assert.equal(r.proposals.skippedDangling, 1); // proposal on the skipped demo job
    assert.equal(r.invoices.inserted, 1);
    assert.equal(r.tasks.inserted, 1);
    assert.equal(r.events.inserted, 1);
    assert.equal(r.events.skippedDangling, 1);

    // Relationships were rewired to fresh ids inside the org.
    const job = await db.get<{ id: number; contact_id: number }>(
      "SELECT id, contact_id FROM jobs WHERE org_id = ? AND title = ?",
      orgId, "Boone re-roof",
    );
    assert.ok(job);
    const contact = await db.get<{ id: number }>(
      "SELECT id FROM contacts WHERE org_id = ? AND name = ?",
      orgId, "Harriet Boone",
    );
    assert.equal(job!.contact_id, contact!.id);
    const lines = await db.all(
      "SELECT pl.id FROM proposal_lines pl JOIN proposals p ON p.id = pl.proposal_id WHERE p.org_id = ? AND p.job_id = ?",
      orgId, job!.id,
    );
    assert.equal(lines.length, 1);
    const pays = await db.all(
      "SELECT pay.id FROM payments pay JOIN invoices i ON i.id = pay.invoice_id WHERE i.org_id = ? AND i.job_id = ?",
      orgId, job!.id,
    );
    assert.equal(pays.length, 1);

    // Measurement resolved its job_ref to the fresh job id.
    const meas = await db.all<{ provider: string; total_squares: number; job_id: number }>(
      "SELECT provider, total_squares, job_id FROM measurements WHERE org_id = ? AND job_id = ?",
      orgId, job!.id,
    );
    assert.equal(meas.length, 1);
    assert.equal(meas[0].provider, "gaf_quickmeasure");
    assert.equal(meas[0].job_id, job!.id);
    // The eagleview report hung off the skipped demo job — never landed.
    const eagle = await db.all(
      "SELECT id FROM measurements WHERE org_id = ? AND provider = 'eagleview'",
      orgId,
    );
    assert.equal(eagle.length, 0);
  });

  await t.test("re-run inserts nothing (natural-key upsert)", async () => {
    const before = {
      contacts: (await db.all("SELECT id FROM contacts WHERE org_id = ?", orgId)).length,
      jobs: (await db.all("SELECT id FROM jobs WHERE org_id = ?", orgId)).length,
      measurements: (await db.all("SELECT id FROM measurements WHERE org_id = ?", orgId)).length,
      proposals: (await db.all("SELECT id FROM proposals WHERE org_id = ?", orgId)).length,
      invoices: (await db.all("SELECT id FROM invoices WHERE org_id = ?", orgId)).length,
      tasks: (await db.all("SELECT id FROM tasks WHERE org_id = ?", orgId)).length,
      events: (await db.all("SELECT id FROM job_events WHERE org_id = ?", orgId)).length,
    };
    const r = await importSnapshot(orgId, snapshot);
    for (const table of ["contacts", "jobs", "measurements", "proposals", "invoices", "tasks", "events"] as const) {
      assert.equal(r[table].inserted, 0, `${table}: nothing new on re-run`);
    }
    assert.equal(r.contacts.existing, 1);
    assert.equal(r.jobs.existing, 1);
    assert.equal(r.measurements.existing, 1);
    assert.equal(r.proposals.existing, 1);
    assert.equal(r.invoices.existing, 1);
    const after = {
      contacts: (await db.all("SELECT id FROM contacts WHERE org_id = ?", orgId)).length,
      jobs: (await db.all("SELECT id FROM jobs WHERE org_id = ?", orgId)).length,
      measurements: (await db.all("SELECT id FROM measurements WHERE org_id = ?", orgId)).length,
      proposals: (await db.all("SELECT id FROM proposals WHERE org_id = ?", orgId)).length,
      invoices: (await db.all("SELECT id FROM invoices WHERE org_id = ?", orgId)).length,
      tasks: (await db.all("SELECT id FROM tasks WHERE org_id = ?", orgId)).length,
      events: (await db.all("SELECT id FROM job_events WHERE org_id = ?", orgId)).length,
    };
    assert.deepEqual(after, before);
  });

  await t.test("demo org untouched — no seed rows duplicated into it", async () => {
    const demoContactsAfter = (await db.all("SELECT id FROM contacts WHERE org_id != ?", orgId)).length;
    assert.equal(demoContactsAfter, demoContactsBefore);
    const strays = await db.all(
      "SELECT id FROM contacts WHERE org_id = ? AND name = ?",
      orgId, "Luc Pamella",
    );
    assert.equal(strays.length, 0);
  });
});
