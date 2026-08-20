/**
 * M4 — org auto-provisioning must not race. The old check-then-INSERT let a
 * concurrent first-login hit the amos_tenant_id UNIQUE constraint and 500.
 * The fix wraps provisioning in a transaction and uses INSERT ... ON CONFLICT
 * DO NOTHING + re-select, so a loser simply adopts the winner's org.
 *
 * Runs on sqlite; the transaction + ON CONFLICT path is shared by both
 * adapters. Also exercises the new Db.transaction commit/rollback contract.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ROOFLINE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "roofline-race-")), "test.db");
delete process.env.DATABASE_URL;

const { getDb, closeDb } = await import("../lib/db.ts");
const { provisionFromIdentity } = await import("../lib/amos-auth.ts");
type AmosIdentity = import("../lib/amos-identity.ts").AmosIdentity;

const identity = (over: Partial<AmosIdentity> = {}): AmosIdentity => ({
  sub: "user_owner",
  org_id: randomUUID(),
  email: "owner@8square.test",
  role: "owner",
  name: "Casey Owner",
  org_name: "8 Square Roofing",
  plan_key: "pro",
  entitlements: [],
  subscription_status: "active",
  app_id: "roofline",
  aud: "roofline",
  iss: "https://app.amoslabs.com",
  exp: Math.floor(Date.now() / 1000) + 300,
  ...over,
});

test("M4: provisioning is race-safe and transactional", async (t) => {
  const db = getDb();
  t.after(async () => closeDb());

  await t.test("adopts an org a concurrent winner already created — no 500", async () => {
    const tenant = randomUUID();
    const winnerOrg = randomUUID();
    // Simulate the winning instance having created the org a beat earlier.
    await db.run(
      "INSERT INTO orgs (id, name, amos_tenant_id) VALUES (?,?,?)",
      winnerOrg, "Winner Co", tenant,
    );
    // The loser's first-login must not throw on the UNIQUE constraint.
    const { orgId, userId } = await provisionFromIdentity(identity({ org_id: tenant }));
    assert.equal(orgId, winnerOrg, "adopted the existing org, not a new one");
    assert.ok(userId > 0);
    const orgs = await db.all("SELECT id FROM orgs WHERE amos_tenant_id = ?", tenant);
    assert.equal(orgs.length, 1, "no duplicate org row");
  });

  await t.test("repeated first-logins for a new tenant are stable", async () => {
    const tenant = randomUUID();
    const a = await provisionFromIdentity(identity({ org_id: tenant }));
    const b = await provisionFromIdentity(identity({ org_id: tenant }));
    assert.equal(a.orgId, b.orgId);
    assert.equal(a.userId, b.userId);
    const orgs = await db.all("SELECT id FROM orgs WHERE amos_tenant_id = ?", tenant);
    assert.equal(orgs.length, 1);
    // Product defaults seeded exactly once (not duplicated on the second login).
    const cat = await db.all("SELECT id FROM catalogue WHERE org_id = ?", a.orgId);
    assert.equal(cat.length, 11);
  });

  await t.test("Db.transaction rolls back on a throw", async () => {
    const before = (await db.all("SELECT id FROM orgs")).length;
    await assert.rejects(
      db.transaction(async (tx) => {
        await tx.run(
          "INSERT INTO orgs (id, name, amos_tenant_id) VALUES (?,?,?)",
          randomUUID(), "Rollback Co", randomUUID(),
        );
        throw new Error("boom");
      }),
      /boom/,
    );
    const after = (await db.all("SELECT id FROM orgs")).length;
    assert.equal(after, before, "the inserted org was rolled back");
  });

  await t.test("Db.transaction commits on success", async () => {
    const tenant = randomUUID();
    await db.transaction(async (tx) => {
      await tx.run(
        "INSERT INTO orgs (id, name, amos_tenant_id) VALUES (?,?,?)",
        randomUUID(), "Commit Co", tenant,
      );
    });
    const row = await db.get("SELECT id FROM orgs WHERE amos_tenant_id = ?", tenant);
    assert.ok(row, "the committed org is visible after the transaction");
  });
});
