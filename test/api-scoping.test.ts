/**
 * M1 — the /api surface must scope a rep-level identity to its own jobs,
 * mirroring the UI's visibleUserIds fencing. The old scopeForRole tested
 * role==='member' (a value mapPlatformRole never emits), so it was dead and
 * every identity got the whole org's jobs/money. Here we exercise the real
 * scoping helpers the routes now use, on sqlite (backend-agnostic).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ROOFLINE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "roofline-apiscope-")), "test.db");
delete process.env.DATABASE_URL;

const { getDb, closeDb } = await import("../lib/db.ts");
const { visibleUserIdsForIdentity } = await import("../lib/amos-auth.ts");
const { repScopeClause } = await import("../lib/api-guard.ts");
type AmosIdentity = import("../lib/amos-identity.ts").AmosIdentity;

/** Minimal identity — the scoping only reads sub/email/role. */
const id = (sub: string, role: string, email = `${sub}@x.test`): AmosIdentity =>
  ({ sub, role, email } as AmosIdentity);

test("M1: API rep scoping mirrors the UI", async (t) => {
  const db = getDb();
  t.after(async () => closeDb());

  const org = randomUUID();
  await db.run("INSERT INTO orgs (id, name, amos_tenant_id) VALUES (?,?,?)", org, "Org", randomUUID());
  const mkUser = async (email: string, role: string, managerId: number | null, sub: string) =>
    (await db.run(
      "INSERT INTO users (org_id, email, name, role, manager_id, amos_sub) VALUES (?,?,?,?,?,?)",
      org, email, email, role, managerId, sub,
    )).lastId;

  const admin = await mkUser("admin@x.test", "admin", null, "sub_admin");
  const mgr = await mkUser("mgr@x.test", "manager", admin, "sub_mgr");
  const rep1 = await mkUser("rep1@x.test", "rep", mgr, "sub_rep1");
  const rep2 = await mkUser("rep2@x.test", "rep", mgr, "sub_rep2");

  await t.test("a rep sees only their own id", async () => {
    assert.deepEqual(await visibleUserIdsForIdentity(org, id("sub_rep1", "rep")), [rep1]);
  });

  await t.test("a manager sees their subtree", async () => {
    const ids = await visibleUserIdsForIdentity(org, id("sub_mgr", "manager"));
    assert.deepEqual([...ids!].sort((a, b) => a - b), [mgr, rep1, rep2].sort((a, b) => a - b));
  });

  await t.test("an admin at the root sees the whole org", async () => {
    const ids = await visibleUserIdsForIdentity(org, id("sub_admin", "owner"));
    assert.deepEqual([...ids!].sort((a, b) => a - b), [admin, mgr, rep1, rep2].sort((a, b) => a - b));
  });

  await t.test("no user row: rep-mapped sees nothing, privileged falls back to org", async () => {
    assert.deepEqual(await visibleUserIdsForIdentity(org, id("ghost", "member")), []);
    assert.equal(await visibleUserIdsForIdentity(org, id("ghost", "owner")), null);
  });

  await t.test("repScopeClause builds the right SQL fragment", async () => {
    const repClause = await repScopeClause(org, id("sub_rep1", "rep"), "j.assignee_id");
    assert.equal(repClause.sql, " AND j.assignee_id IN (?)");
    assert.deepEqual(repClause.params, [rep1]);

    // An admin WITH a row is scoped to its subtree (here, the whole org).
    const adminClause = await repScopeClause(org, id("sub_admin", "owner"));
    assert.equal(adminClause.sql, " AND assignee_id IN (?,?,?,?)");
    assert.deepEqual([...adminClause.params].sort(), [admin, mgr, rep1, rep2].sort());

    // A privileged identity with NO row falls back to the whole org (no filter).
    const noRowAdmin = await repScopeClause(org, id("ghost_admin", "owner"));
    assert.equal(noRowAdmin.sql, "");
    assert.deepEqual(noRowAdmin.params, []);

    const lockedOut = await repScopeClause(org, id("ghost", "member"));
    assert.equal(lockedOut.sql, " AND 1 = 0"); // fails closed
    assert.deepEqual(lockedOut.params, []);
  });

  await t.test("scoping is org-fenced: a rep in another org yields nothing here", async () => {
    const other = randomUUID();
    await db.run("INSERT INTO orgs (id, name, amos_tenant_id) VALUES (?,?,?)", other, "Other", randomUUID());
    // identity's sub only exists in `org`; querying against `other` finds no row
    assert.deepEqual(await visibleUserIdsForIdentity(other, id("sub_rep1", "rep")), []);
  });
});
