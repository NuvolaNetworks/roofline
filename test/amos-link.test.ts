/**
 * Roofline → AMOS: the service key, signed tokens, the transport's retry
 * rules, and what the signing flow queues (events + emails) — against the
 * sqlite demo DB with the demo org linked to an AMOS org.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, verify } from "node:crypto";
import { createSqliteDb } from "../lib/db-sqlite.ts";
import { DEMO_ORG_ID } from "../lib/demo-fixtures.ts";
import { AUDIENCE, amosTransport, keyDocument, publicKeyObject, resetServiceKeyCache, serviceKey, servicesUrl, signServiceToken } from "../lib/amos-link.ts";
import { drain, type OutboxRow } from "../lib/amos-outbox.ts";
import { countersign, createEnvelope, issueDownloadLink, sessionForToken, signByToken } from "../lib/esign.ts";
import { notifyCompleted, notifyCustomerSigned, notifySent } from "../lib/esign-notify.ts";
import { loadProposalModel } from "../lib/proposal-data.ts";
import { makePng } from "./fixtures/png.ts";

process.env.ROOFLINE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "roofline-link-")), "t.db");
process.env.ROOFLINE_SESSION_SECRET = "test-secret-for-app-key-wrapping";
const db = createSqliteDb();
const org = DEMO_ORG_ID;
const AMOS_ORG = "aa193fa0-2229-415e-a609-35076a8afb01";
const APP = "082c7568-54f5-41d5-be39-4e4a99afc700";

test("service key is created once, persisted encrypted, and stable", async () => {
  resetServiceKeyCache();
  const a = await serviceKey(db);
  resetServiceKeyCache();
  const b = await serviceKey(db);
  assert.equal(a.kid, b.kid);
  assert.equal(a.publicKey, b.publicKey);
  assert.equal(Buffer.from(a.publicKey, "base64url").length, 32);
  const row = await db.get<{ private_key_enc: string }>("SELECT private_key_enc FROM app_service_key");
  assert.ok(row && !row.private_key_enc.includes("PRIVATE"), "stored encrypted, not PEM");
  assert.deepEqual(Object.keys(keyDocument(a)).sort(), ["alg", "kid", "public_key"]);
});

test("tokens are EdDSA, bound to the body, short-lived, and verify with the published key", async () => {
  const k = await serviceKey(db);
  const body = Buffer.from('{"kind":"event"}');
  const now = 1_790_000_000;
  const t = signServiceToken(k, APP, body, now);
  const [h, c, s] = t.split(".");
  const header = JSON.parse(Buffer.from(h, "base64url").toString());
  const claims = JSON.parse(Buffer.from(c, "base64url").toString());
  assert.deepEqual(header, { alg: "EdDSA", typ: "JWT", kid: k.kid });
  assert.equal(claims.iss, APP);
  assert.equal(claims.aud, AUDIENCE);
  assert.equal(claims.exp - claims.iat, 60);
  assert.equal(claims.bh, createHash("sha256").update(body).digest("base64url"));
  assert.ok(verify(null, Buffer.from(`${h}.${c}`), publicKeyObject(k), Buffer.from(s, "base64url")));
});

test("services URL follows the platform origin", () => {
  assert.equal(servicesUrl({}), "https://app.amoslabs.com/api/v1/app-services/messages");
  assert.equal(servicesUrl({ AMOS_APP_AUTH_JWKS_URL: "https://staging.amos.test/.well-known/x" }), "https://staging.amos.test/api/v1/app-services/messages");
});

test("transport: 2xx ok, 400 dead, 401/404/429/5xx/network retry", async () => {
  const row = { id: 1, kind: "event", payload: '{"kind":"event"}' } as unknown as OutboxRow;
  const env = { AMOS_APP_AUTH_APP_ID: APP };
  const respond = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status });
  let seenAuth = "";
  const ok = await amosTransport(db, { env, fetchImpl: async (_u, init) => {
    seenAuth = String((init?.headers as Record<string, string>).authorization);
    return new Response('{"status":"accepted"}', { status: 200 });
  } }).deliver(row);
  assert.equal(ok.ok, true);
  assert.match(seenAuth, /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  const bad = await amosTransport(db, { env, fetchImpl: respond(400, { code: "invalid_email", retryable: false }) }).deliver(row);
  assert.deepEqual([bad.ok, bad.ok ? null : bad.retry], [false, false]);
  for (const status of [401, 404, 429, 503]) {
    const r = await amosTransport(db, { env, fetchImpl: respond(status, {}) }).deliver(row);
    assert.equal(!r.ok && r.retry, true, `status ${status} retries`);
  }
  const net = await amosTransport(db, { env, fetchImpl: async () => { throw new Error("ECONNREFUSED"); } }).deliver(row);
  assert.equal(!net.ok && net.retry, true);
  const noApp = await amosTransport(db, { env: {}, fetchImpl: respond(200, {}) }).deliver(row);
  assert.equal(!noApp.ok && noApp.retry, true);
});

test("signing flow queues the right events and emails, and delivered emails are redacted", async () => {
  await db.run("UPDATE orgs SET amos_tenant_id = ? WHERE id = ?", AMOS_ORG, org);
  const p = await db.get<{ id: number; job_id: number }>("SELECT id, job_id FROM proposals WHERE org_id = ? AND status = 'Draft' ORDER BY id LIMIT 1", org);
  assert.ok(p);
  await db.run(
    "INSERT INTO proposal_lines (org_id, proposal_id, sku, name, unit, qty, unit_price_cents) VALUES (?,?,?,?,?,?,?)",
    org, p.id, "X", "Roof", "square", 30, 50000,
  );
  const job = (await db.get<{ assignee_id: number }>("SELECT assignee_id FROM jobs WHERE id = ?", p.job_id))!;
  const rep = (await db.get<{ id: number; name: string; email: string }>("SELECT id, name, email FROM users WHERE id = ?", job.assignee_id))!;
  const loaded = (await loadProposalModel(db, org, p.id, rep))!;
  const origin = "https://roofline.custom.amoslabs.com";
  const { envelopeId, token } = await createEnvelope(db, org, p.id, p.job_id, loaded.model, rep, loaded.rep);
  await notifySent(db, org, envelopeId, token, origin);
  await notifySent(db, org, envelopeId, token, origin); // double submit: no duplicates

  const client = { ip: "203.0.113.1", userAgent: "t" };
  const sig = { png: makePng(), method: "drawn" as const, typedName: "", consented: true };
  assert.equal(await signByToken(db, (await sessionForToken(db, token))!, sig, client), false);
  await notifyCustomerSigned(db, org, envelopeId, origin);
  assert.equal(await countersign(db, org, envelopeId, rep.id, sig, client), true);
  const download = await issueDownloadLink(db, org, envelopeId);
  assert.ok(download);
  assert.equal(await sessionForToken(db, token), null, "old link rotated out");
  assert.equal((await sessionForToken(db, download!))?.envelope.status, "Completed");
  await notifyCompleted(db, org, envelopeId, download, origin);

  const rows = await db.all<OutboxRow>("SELECT * FROM amos_outbox WHERE idempotency_key LIKE ? ORDER BY id", `env-${envelopeId}-%`);
  const topics = rows.map((r) => `${r.kind}:${r.topic}`);
  assert.deepEqual(topics, [
    "event:proposal.sent",
    "email:proposal.signature_request",
    "event:proposal.customer_signed",
    "email:proposal.countersign_request",
    "event:proposal.signed",
    "email:proposal.signed_copy",
    "email:proposal.completed",
  ]);
  const request = JSON.parse(rows[1].payload);
  assert.equal(request.org_id, AMOS_ORG);
  assert.equal(request.kind, "email");
  assert.equal(request.idempotency_key, rows[1].idempotency_key);
  assert.match(request.cta.url, new RegExp(`^${origin}/sign/`));
  assert.equal(request.reply_to, rep.email);
  const signed = JSON.parse(rows[4].payload);
  assert.equal(signed.data.total_cents, 30 * 50000);

  // Deliver everything; email payloads are scrubbed once AMOS has them.
  await drain(db, { deliver: async () => ({ ok: true, response: { status: "accepted" } }) }, { now: Date.now() + 1000, limit: 50 });
  const after = await db.all<OutboxRow>("SELECT * FROM amos_outbox WHERE idempotency_key LIKE ? ORDER BY id", `env-${envelopeId}-%`);
  assert.ok(after.every((r) => r.status === "delivered"));
  assert.ok(after.filter((r) => r.kind === "email").every((r) => r.payload === '{"redacted":true}'));
  assert.ok(after.filter((r) => r.kind === "event").every((r) => r.payload !== '{"redacted":true}'));
});

test("orgs not linked to AMOS queue nothing", async () => {
  await db.run("UPDATE orgs SET amos_tenant_id = NULL WHERE id = ?", org);
  const before = (await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM amos_outbox"))!.n;
  await notifySent(db, org, 1, "tok", "https://x");
  assert.equal((await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM amos_outbox"))!.n, before);
});
