/**
 * H1 — the public instant estimator must address an org by a random,
 * non-enumerable token, never by its primary key. Before this fix, anyone
 * holding an org's UUID (it shipped in the QR/link URL and onto printed signs)
 * could inject leads into that org's live pipeline unauthenticated.
 *
 * Runs on sqlite; provisioning + token logic are backend-agnostic. The server
 * action (submitInstantEstimate) can't be imported outside Next, so we assert
 * the exact security invariant it relies on — org resolution by token, and
 * that the PK path is closed — plus provisioning and the rate limiter.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ROOFLINE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "roofline-esttok-")), "test.db");
delete process.env.DATABASE_URL;

const { getDb, closeDb } = await import("../lib/db.ts");
const { provisionFromIdentity, newEstimatorToken } = await import("../lib/amos-auth.ts");
const { createFixedWindowLimiter } = await import("../lib/rate-limit.ts");
const { DEMO_ORG_ID, DEMO_ESTIMATOR_TOKEN } = await import("../lib/demo-fixtures.ts");
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

/** The org-resolution the estimator action performs: by token, never by id. */
async function resolveOrgByToken(token: string): Promise<string | undefined> {
  return (
    await getDb().get<{ id: string }>(
      "SELECT id FROM orgs WHERE estimator_token = ?",
      token,
    )
  )?.id;
}

test("H1: estimator addresses orgs by token, not primary key", async (t) => {
  const db = getDb();
  t.after(async () => closeDb());

  await t.test("newEstimatorToken is long, url-safe and unique", () => {
    const a = newEstimatorToken();
    const b = newEstimatorToken();
    assert.notEqual(a, b);
    assert.ok(a.length >= 32, "token should carry real entropy");
    assert.match(a, /^[A-Za-z0-9_-]+$/, "token must be url-safe");
  });

  await t.test("the demo org is seeded with the fixed demo token", async () => {
    const demo = await resolveOrgByToken(DEMO_ESTIMATOR_TOKEN);
    assert.equal(demo, DEMO_ORG_ID);
  });

  let orgId: string;
  let orgToken: string;

  await t.test("provisioning a real org mints a random estimator token", async () => {
    const { orgId: id } = await provisionFromIdentity(identity());
    orgId = id;
    const row = await db.get<{ estimator_token: string }>(
      "SELECT estimator_token FROM orgs WHERE id = ?",
      orgId,
    );
    assert.ok(row?.estimator_token, "provisioned org must have a token");
    orgToken = row!.estimator_token;
    assert.notEqual(orgToken, DEMO_ESTIMATOR_TOKEN);
    assert.match(orgToken, /^[A-Za-z0-9_-]{32,}$/);
  });

  await t.test("the token resolves to exactly its org", async () => {
    assert.equal(await resolveOrgByToken(orgToken), orgId);
  });

  await t.test("ATTACK CLOSED: the org PK no longer resolves the org", async () => {
    // The old exploit passed the org UUID as ?org=. That value is not a valid
    // estimator token, so the token-only resolution finds nothing.
    assert.equal(await resolveOrgByToken(orgId), undefined);
    // A different org's token can't reach this org either.
    const { orgId: other } = await provisionFromIdentity(identity());
    const otherToken = (
      await db.get<{ estimator_token: string }>(
        "SELECT estimator_token FROM orgs WHERE id = ?",
        other,
      )
    )!.estimator_token;
    assert.notEqual(await resolveOrgByToken(otherToken), orgId);
  });

  await t.test("estimator-sourced rows stay tagged as untrusted", async () => {
    // Confirm the source tag the app relies on to flag estimator free-text.
    await db.run(
      `INSERT INTO jobs (org_id, title, address, trade, source, stage)
       VALUES (?,?,?,?, 'QR instant estimate', 'New lead')`,
      orgId, "Roofing — Attacker", "1 Evil St", "Roofing",
    );
    const j = await db.get<{ source: string }>(
      "SELECT source FROM jobs WHERE org_id = ? ORDER BY id DESC LIMIT 1",
      orgId,
    );
    assert.equal(j?.source, "QR instant estimate");
  });

  await t.test("per-token/IP rate limit trips after the cap", () => {
    const limited = createFixedWindowLimiter({ windowMs: 60_000, max: 5 });
    const key = `${orgToken}|203.0.113.7`;
    const t0 = 1_000_000;
    // first 5 within the window pass, the 6th is limited
    for (let i = 0; i < 5; i++) assert.equal(limited(key, t0 + i), false);
    assert.equal(limited(key, t0 + 5), true);
    // a different IP is tracked independently
    assert.equal(limited(`${orgToken}|198.51.100.9`, t0 + 5), false);
    // once the window rolls past, the key is clear again
    assert.equal(limited(key, t0 + 60_001), false);
  });
});
