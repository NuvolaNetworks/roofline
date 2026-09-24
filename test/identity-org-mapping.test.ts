/**
 * Identity → org mapping: a verified AMOS identity token's tenant claim maps
 * onto our orgs table — auto-provisioned on first login (with product
 * defaults seeded), stable on every login after, and users are matched by
 * IdP subject/email inside the org with claims refreshed each time. Runs on
 * the sqlite backend; the mapping code is backend-agnostic.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ROOFLINE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "roofline-idmap-")), "test.db");
delete process.env.DATABASE_URL;

const { getDb, closeDb } = await import("../lib/db.ts");
const { provisionFromIdentity, findOrgByTenant, mapPlatformRole } = await import("../lib/amos-auth.ts");
type AmosIdentity = import("../lib/amos-identity.ts").AmosIdentity;

const tenant = randomUUID();
const identity = (over: Partial<AmosIdentity> = {}): AmosIdentity => ({
  sub: "user_8sq_owner",
  org_id: tenant,
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

test("identity → org mapping", async (t) => {
  const db = getDb();
  t.after(async () => closeDb());

  await t.test("role claim mapping is least-privilege", () => {
    assert.equal(mapPlatformRole("owner"), "admin");
    assert.equal(mapPlatformRole("Admin"), "admin");
    assert.equal(mapPlatformRole("manager"), "manager");
    assert.equal(mapPlatformRole("member"), "rep");
    assert.equal(mapPlatformRole(undefined), "rep");
    assert.equal(mapPlatformRole("something-new"), "rep");
  });

  await t.test("unknown tenant has no mapping (API guard rejects)", async () => {
    assert.equal(await findOrgByTenant(tenant), null);
    assert.equal(await findOrgByTenant("not-a-uuid"), null);
  });

  let orgId: string;
  let userId: number;

  await t.test("first login provisions org + user + product defaults", async () => {
    const first = await provisionFromIdentity(identity());
    orgId = first.orgId;
    userId = first.userId;
    const org = await db.get<{ name: string; amos_tenant_id: string }>(
      "SELECT name, amos_tenant_id FROM orgs WHERE id = ?", orgId,
    );
    assert.equal(org?.name, "8 Square Roofing");
    assert.equal(org?.amos_tenant_id, tenant);
    const user = await db.get<{ email: string; role: string; org_id: string }>(
      "SELECT email, role, org_id FROM users WHERE id = ?", userId,
    );
    assert.deepEqual({ ...user }, { email: "owner@8square.test", role: "admin", org_id: orgId });
    // A fresh org starts with the product defaults, not empty tooling.
    const templates = await db.all("SELECT id FROM templates WHERE org_id = ?", orgId);
    assert.equal(templates.length, 5);
    const catalogue = await db.all("SELECT id FROM catalogue WHERE org_id = ?", orgId);
    assert.equal(catalogue.length, 11);
    assert.equal(await findOrgByTenant(tenant), orgId);
  });

  await t.test("second login is stable and refreshes claims", async () => {
    const again = await provisionFromIdentity(identity({ role: "manager", name: "Casey O." }));
    assert.equal(again.orgId, orgId);
    assert.equal(again.userId, userId);
    const user = await db.get<{ name: string; role: string }>(
      "SELECT name, role FROM users WHERE id = ?", userId,
    );
    assert.deepEqual({ ...user }, { name: "Casey O.", role: "manager" });
    const orgs = await db.all("SELECT id FROM orgs WHERE amos_tenant_id = ?", tenant);
    assert.equal(orgs.length, 1);
  });

  await t.test("same email in a different tenant is a different org + user", async () => {
    const otherTenant = randomUUID();
    const other = await provisionFromIdentity(identity({ org_id: otherTenant, sub: "user_other" }));
    assert.notEqual(other.orgId, orgId);
    assert.notEqual(other.userId, userId);
  });

  await t.test("demo users exist only in the demo org", async () => {
    const demoInRealOrg = await db.all(
      "SELECT id FROM users WHERE org_id = ? AND email LIKE '%@demo.roofline'", orgId,
    );
    assert.equal(demoInRealOrg.length, 0);
  });
});
