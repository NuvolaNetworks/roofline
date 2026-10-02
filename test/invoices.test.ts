/**
 * Invoices from proposals: 50% deposit, remaining balance, over-billing
 * refused, homeowner link, partial then full payment, stage moves, voiding,
 * the job's money picture, the PDF, and the AMOS messages queued.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument } from "pdf-lib";
import { createSqliteDb } from "../lib/db-sqlite.ts";
import { DEMO_ORG_ID } from "../lib/demo-fixtures.ts";
import {
  addJobCost,
  createProposalInvoice,
  getInvoice,
  invoiceForToken,
  jobMoney,
  proposalBilling,
  recordInvoiceView,
  recordPayment,
  sendInvoice,
  voidInvoice,
} from "../lib/invoices.ts";
import { applyProposalSigned } from "../lib/proposal-effects.ts";
import { loadInvoiceModel, renderInvoicePdf } from "../lib/invoice-doc.ts";
import { notifyInvoiceSent, notifyPayment } from "../lib/invoice-notify.ts";

process.env.ROOFLINE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "roofline-inv-")), "t.db");
const db = createSqliteDb();
const org = DEMO_ORG_ID;
const pay = (amount_cents: number) => ({ amount_cents, method: "Check", reference: "1001", received_on: "2026-10-02", note: "", recorded_by: null, actor: "test" });

async function signedProposal(total = 2561269): Promise<{ id: number; jobId: number }> {
  const job = (await db.get<{ id: number }>("SELECT id FROM jobs WHERE org_id = ? ORDER BY id DESC LIMIT 1", org))!;
  const p = await db.run("INSERT INTO proposals (org_id, job_id, name, status, total_cents) VALUES (?,?,?, 'Draft', ?)", org, job.id, "Roof — 1 Main St", total);
  await db.run(
    "INSERT INTO proposal_lines (org_id, proposal_id, sku, name, unit, qty, unit_price_cents, section) VALUES (?,?,?,?,?,?,?,?)",
    org, p.lastId, "X", "Complete roof replacement", "each", 1, total, "Work Scope",
  );
  await db.run("UPDATE jobs SET stage = 'Prospect' WHERE id = ?", job.id);
  await applyProposalSigned(db, org, p.lastId, "test");
  return { id: p.lastId, jobId: job.id };
}

test("signing drafts one 50% deposit invoice linked to the proposal", async () => {
  const { id } = await signedProposal(1000000);
  const invs = await db.all<{ title: string; percent: number; amount_cents: number; number: string; status: string }>(
    "SELECT title, percent, amount_cents, number, status FROM invoices WHERE proposal_id = ?", id,
  );
  assert.equal(invs.length, 1);
  assert.deepEqual([invs[0].title, Number(invs[0].percent), Number(invs[0].amount_cents), invs[0].status], ["50% deposit", 50, 500000, "Draft"]);
  assert.match(invs[0].number, /^INV-\d{5}$/);
  await applyProposalSigned(db, org, id, "again"); // idempotent
  assert.equal((await db.all("SELECT id FROM invoices WHERE proposal_id = ?", id)).length, 1);
});

test("deposit then remaining balance bills exactly the contract; over-billing is refused", async () => {
  const { id, jobId } = await signedProposal(2561269);
  const deposit = (await db.get<{ id: number }>("SELECT id FROM invoices WHERE proposal_id = ?", id))!.id;
  await assert.rejects(createProposalInvoice(db, org, id, { mode: "amount", amount_cents: 2000000 }, { actor: "t" }), /more than/);
  const final = await createProposalInvoice(db, org, id, { mode: "remaining" }, { actor: "t" });
  const f = (await getInvoice(db, org, final))!;
  assert.equal(Number(f.amount_cents), 2561269 - Math.round(2561269 / 2));
  assert.equal(f.title, "Final payment");
  assert.equal(f.kind, "Balance");
  const b = (await proposalBilling(db, org, id))!;
  assert.equal(b.unbilled_cents, 0);
  await assert.rejects(createProposalInvoice(db, org, id, { mode: "remaining" }, { actor: "t" }), /already invoiced/);

  // Send the deposit: link works, view recorded once.
  const token = await sendInvoice(db, org, Number(deposit), "rep");
  const viaLink = (await invoiceForToken(db, token))!;
  assert.equal(viaLink.id, deposit);
  assert.equal(viaLink.status, "Sent");
  assert.equal(await recordInvoiceView(db, viaLink), true);
  assert.equal(await recordInvoiceView(db, viaLink), false);
  assert.equal(await invoiceForToken(db, token + "x"), null);
  // Resend rotates the link.
  const token2 = await sendInvoice(db, org, Number(deposit), "rep");
  assert.equal(await invoiceForToken(db, token), null);
  assert.ok(await invoiceForToken(db, token2));

  // Partial, then full payment.
  const half = Math.round(2561269 / 2);
  assert.equal(await recordPayment(db, org, Number(deposit), pay(100000)), false);
  assert.equal((await getInvoice(db, org, Number(deposit)))!.status, "Partially paid");
  await assert.rejects(recordPayment(db, org, Number(deposit), pay(half)), /more than/);
  assert.equal(await recordPayment(db, org, Number(deposit), pay(half - 100000)), true);
  assert.equal((await getInvoice(db, org, Number(deposit)))!.status, "Paid");
  await assert.rejects(voidInvoice(db, org, Number(deposit), "t"), /can't be voided/);

  // Sending the final invoice moves the job to Completed/Invoiced; paying it → Ready for Commission.
  await sendInvoice(db, org, final, "rep");
  assert.equal((await db.get<{ stage: string }>("SELECT stage FROM jobs WHERE id = ?", jobId))!.stage, "Completed/Invoiced");
  await recordPayment(db, org, final, pay(Number(f.amount_cents)));
  assert.equal((await db.get<{ stage: string }>("SELECT stage FROM jobs WHERE id = ?", jobId))!.stage, "Ready for Commission");

  // Job money.
  await addJobCost(db, org, jobId, { category: "materials", vendor: "SRS", description: "shingles", amount_cents: 900000, incurred_on: "2026-10-01", created_by: null });
  await addJobCost(db, org, jobId, { category: "labor", vendor: "Crew", description: "", amount_cents: 600000, incurred_on: null, created_by: null });
  const money = await jobMoney(db, org, jobId);
  assert.equal(money.collected_cents >= 2561269, true);
  assert.equal(money.outstanding_cents, 0);
  assert.equal(money.actual_cost_cents >= 1500000, true);
  assert.equal(money.profit_cents, money.contract_cents - money.actual_cost_cents);

  // The PDF renders from the proposal scope with the payments.
  const m = (await loadInvoiceModel(db, org, (await getInvoice(db, org, Number(deposit)))!))!;
  assert.equal(m.balance_cents, 0);
  assert.equal(m.payments.length, 2);
  assert.equal(m.scope[0].lines[0].name, "Complete roof replacement");
  const pdf = await PDFDocument.load(await renderInvoicePdf(db, org, m));
  assert.ok(pdf.getPageCount() >= 1);
});

test("void frees the amount to bill again", async () => {
  const { id } = await signedProposal(400000);
  const dep = (await db.get<{ id: number }>("SELECT id FROM invoices WHERE proposal_id = ?", id))!.id;
  const token = await sendInvoice(db, org, Number(dep), "rep");
  await voidInvoice(db, org, Number(dep), "rep");
  assert.equal(await invoiceForToken(db, token), null, "voided link is dead");
  assert.equal((await proposalBilling(db, org, id))!.unbilled_cents, 400000);
  const pct = await createProposalInvoice(db, org, id, { mode: "percent", percent: 30 }, { actor: "t" });
  assert.equal(Number((await getInvoice(db, org, pct))!.amount_cents), 120000);
});

test("invoice email + events queue for AMOS-linked orgs", async () => {
  await db.run("UPDATE orgs SET amos_tenant_id = 'aa193fa0-2229-415e-a609-35076a8afb01' WHERE id = ?", org);
  const { id, jobId } = await signedProposal(300000);
  const contact = await db.get<{ contact_id: number }>("SELECT contact_id FROM jobs WHERE id = ?", jobId);
  await db.run("UPDATE contacts SET email = 'home@example.com' WHERE id = ?", contact!.contact_id);
  const dep = Number((await db.get<{ id: number }>("SELECT id FROM invoices WHERE proposal_id = ?", id))!.id);
  const token = await sendInvoice(db, org, dep, "rep");
  await notifyInvoiceSent(db, org, dep, token, "https://roofline.custom.amoslabs.com");
  await recordPayment(db, org, dep, pay(150000));
  await notifyPayment(db, org, dep, "p1", true);
  const rows = await db.all<{ kind: string; topic: string; payload: string }>(
    "SELECT kind, topic, payload FROM amos_outbox WHERE idempotency_key LIKE ? ORDER BY id", `inv-${dep}-%`,
  );
  assert.deepEqual(rows.map((r) => `${r.kind}:${r.topic}`), ["event:invoice.sent", "email:invoice.sent", "event:payment.received", "event:invoice.paid"]);
  const email = JSON.parse(rows[1].payload);
  assert.equal(email.to[0].email, "home@example.com");
  assert.match(email.cta.url, /^https:\/\/roofline\.custom\.amoslabs\.com\/invoice\//);
  assert.match(email.subject, /INV-\d{5}/);
  await db.run("UPDATE orgs SET amos_tenant_id = NULL WHERE id = ?", org);
});
