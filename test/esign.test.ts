/**
 * End-to-end signing against the sqlite demo database: send → customer
 * views + signs by link → contractor countersigns in-app → final PDF is
 * filed, hashed, and the job moves. Plus the refusals: bad tokens, wrong
 * countersigner, double send, void, decline.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument } from "pdf-lib";
import { createSqliteDb } from "../lib/db-sqlite.ts";
import { DEMO_ORG_ID } from "../lib/demo-fixtures.ts";
import type { Db } from "../lib/db.ts";
import {
  ACTIVE,
  canonicalJson,
  countersign,
  createEnvelope,
  declineByToken,
  decodeSignaturePng,
  getSigners,
  latestEnvelope,
  recordView,
  reissueCustomerLink,
  sessionForToken,
  signByToken,
  voidEnvelope,
} from "../lib/esign.ts";
import { getFile, putFile, FileRejected, sha256Hex } from "../lib/files.ts";
import { loadProposalModel } from "../lib/proposal-data.ts";
import { makePng, pngDataUrl } from "./fixtures/png.ts";

process.env.ROOFLINE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "roofline-esign-")), "t.db");
const db: Db = createSqliteDb();
const org = DEMO_ORG_ID;
const client = { ip: "203.0.113.7", userAgent: "TestBrowser/1.0" };

async function draftProposal(): Promise<{ id: number; jobId: number; repId: number }> {
  const p = await db.get<{ id: number; job_id: number }>(
    "SELECT id, job_id FROM proposals WHERE org_id = ? AND status = 'Draft' ORDER BY id LIMIT 1", org,
  );
  assert.ok(p);
  await db.run("UPDATE proposals SET status = 'Draft' WHERE id = ?", p.id);
  const job = await db.get<{ assignee_id: number }>("SELECT assignee_id FROM jobs WHERE id = ?", p.job_id);
  await db.run(
    "INSERT INTO proposal_lines (org_id, proposal_id, sku, name, unit, qty, unit_price_cents, section, notes) VALUES (?,?,?,?,?,?,?,?,?)",
    org, p.id, "X-1", "Concrete pour", "sq ft", 640, 1200, "Driveway", "- 4\" slab",
  );
  return { id: Number(p.id), jobId: Number(p.job_id), repId: Number(job!.assignee_id) };
}

const sig = { png: makePng(), method: "drawn" as const, typedName: "", consented: true };

test("canonical JSON is key-order independent", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: null } }), canonicalJson({ a: { c: null, d: [1, { y: 2, z: 1 }] }, b: 1 }));
});

test("files: sniffed type, size cap, org fence", async () => {
  const png = makePng();
  const f = await putFile(db, org, "logo", "../../etc/logo.png", png);
  assert.equal(f.content_type, "image/png");
  const back = await getFile(db, org, f.id);
  assert.equal(back?.filename, "logo.png");
  assert.equal(sha256Hex(back!.bytes), f.sha256);
  assert.equal(await getFile(db, "00000000-0000-4000-8000-00000000ffff", f.id), null);
  await assert.rejects(putFile(db, org, "attachment", "x.exe", new TextEncoder().encode("MZ......")), FileRejected);
  await assert.rejects(putFile(db, org, "signature", "s.pdf", new TextEncoder().encode("%PDF-1.4"), ["image/png"]), FileRejected);
});

test("signature images are validated", async () => {
  assert.ok((await decodeSignaturePng(pngDataUrl())).length > 0);
  await assert.rejects(decodeSignaturePng("data:image/png;base64,AAAA"), /couldn't be read/);
  await assert.rejects(decodeSignaturePng("javascript:alert(1)"), /draw or type/);
});

test("full flow: send, view, sign, countersign, finalize", async () => {
  const { id, jobId, repId } = await draftProposal();
  const rep = (await db.get<{ id: number; name: string; email: string }>("SELECT id, name, email FROM users WHERE id = ?", repId))!;
  const loaded = await loadProposalModel(db, org, id, rep);
  assert.ok(loaded);
  const { envelopeId, token } = await createEnvelope(db, org, id, jobId, loaded.model, { id: rep.id, name: rep.name }, loaded.rep);
  assert.equal((await db.get<{ status: string }>("SELECT status FROM proposals WHERE id = ?", id))?.status, "Sent");

  await assert.rejects(createEnvelope(db, org, id, jobId, loaded.model, rep, loaded.rep), /already out for signature/);
  assert.equal(await sessionForToken(db, token + "x"), null);
  assert.equal(await sessionForToken(db, ""), null);

  const s = await sessionForToken(db, token);
  assert.ok(s);
  assert.equal(s.signer.role, "customer");
  await recordView(db, s, client);
  await recordView(db, s, client); // second view is not a new event
  assert.equal((await db.get<{ status: string }>("SELECT status FROM proposals WHERE id = ?", id))?.status, "Viewed");

  const done1 = await signByToken(db, (await sessionForToken(db, token))!, sig, client);
  assert.equal(done1, false, "contractor still to sign");
  await assert.rejects(signByToken(db, (await sessionForToken(db, token))!, sig, client), /already signed/);

  const other = await db.get<{ id: number }>("SELECT id FROM users WHERE org_id = ? AND id != ? LIMIT 1", org, repId);
  await assert.rejects(countersign(db, org, envelopeId, other!.id, sig, client), /Only .* can countersign/);
  await assert.rejects(countersign(db, org, envelopeId, rep.id, { ...sig, consented: false }, client), /agree/);
  assert.equal(await countersign(db, org, envelopeId, rep.id, sig, client), true);

  const env = (await latestEnvelope(db, org, id))!;
  assert.equal(env.status, "Completed");
  const final = (await getFile(db, org, Number(env.final_file_id)))!;
  assert.equal(final.sha256, env.final_sha256);
  const pdf = await PDFDocument.load(final.bytes);
  assert.ok(pdf.getPageCount() >= 5, "document + certificate");

  const p = (await db.get<{ status: string }>("SELECT status FROM proposals WHERE id = ?", id))!;
  assert.equal(p.status, "Signed");
  const job = (await db.get<{ stage: string; value_cents: number }>("SELECT stage, value_cents FROM jobs WHERE id = ?", jobId))!;
  assert.equal(job.stage, "Approved");
  assert.equal(Number(job.value_cents), 640 * 1200);
  const doc = await db.get<{ file_id: number }>("SELECT file_id FROM documents WHERE envelope_id = ?", envelopeId);
  assert.equal(Number(doc?.file_id), Number(env.final_file_id));
  const events = (await db.all<{ event: string }>("SELECT event FROM envelope_events WHERE envelope_id = ? ORDER BY id", envelopeId)).map((e) => e.event);
  assert.deepEqual(events, ["created", "sent", "viewed", "consented", "signed", "consented", "signed", "completed"]);
  const signers = await getSigners(db, org, envelopeId);
  assert.ok(signers.every((x) => x.ip === client.ip && x.status === "Signed"));

  // The customer can still open the completed envelope to download it.
  assert.equal((await sessionForToken(db, token))?.envelope.status, "Completed");
});

test("void kills the link and returns the proposal to draft; reissue rotates the token", async () => {
  const p = await db.run("INSERT INTO proposals (org_id, job_id, name, status) VALUES (?, (SELECT id FROM jobs WHERE org_id = ? LIMIT 1), 'Void me', 'Draft')", org, org);
  const loaded = (await loadProposalModel(db, org, p.lastId, { id: 1, name: "Jeff", email: "" }))!;
  const sender = { id: 1, name: "Jeff" };
  const { envelopeId, token } = await createEnvelope(db, org, p.lastId, loaded.proposal.job_id, loaded.model, sender, loaded.rep);
  const fresh = await reissueCustomerLink(db, org, envelopeId, sender);
  assert.equal(await sessionForToken(db, token), null, "old link dead");
  assert.ok(await sessionForToken(db, fresh));
  await voidEnvelope(db, org, envelopeId, sender, "price change");
  assert.equal(await sessionForToken(db, fresh), null);
  assert.equal((await db.get<{ status: string }>("SELECT status FROM proposals WHERE id = ?", p.lastId))?.status, "Draft");
  assert.equal((await latestEnvelope(db, org, p.lastId))?.status, "Voided");
});

test("decline records the reason and closes the envelope", async () => {
  const p = await db.run("INSERT INTO proposals (org_id, job_id, name, status) VALUES (?, (SELECT id FROM jobs WHERE org_id = ? LIMIT 1), 'Decline me', 'Draft')", org, org);
  const loaded = (await loadProposalModel(db, org, p.lastId, { id: 1, name: "Jeff", email: "" }))!;
  const { token } = await createEnvelope(db, org, p.lastId, loaded.proposal.job_id, loaded.model, { id: 1, name: "Jeff" }, loaded.rep);
  const s = (await sessionForToken(db, token))!;
  await declineByToken(db, s, "Went with another bid", client);
  const env = (await latestEnvelope(db, org, p.lastId))!;
  assert.equal(env.status, "Declined");
  assert.notEqual(env.status, ACTIVE);
  assert.equal((await db.get<{ status: string }>("SELECT status FROM proposals WHERE id = ?", p.lastId))?.status, "Declined");
  await assert.rejects(signByToken(db, (await sessionForToken(db, token))!, sig, client), /no longer awaiting/);
});
