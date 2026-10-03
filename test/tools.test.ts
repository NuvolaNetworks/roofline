/**
 * The AI tool surface end to end on the sqlite demo org: an admin runs the
 * whole lead → measurement → proposal → signature → invoice → payment →
 * costs flow through runTool, a rep sees only their own jobs, and bad input
 * comes back as a 400 with the reason. Also: the publish payload matches the
 * registry and every tool has a flat path (the AMOS proxy fills no
 * placeholders).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteDb } from "../lib/db-sqlite.ts";
import { DEMO_ORG_ID } from "../lib/demo-fixtures.ts";
import type { AmosIdentity } from "../lib/amos-identity.ts";
import { publishPayload, runTool, toolContext, TOOLS } from "../lib/tools.ts";

process.env.ROOFLINE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "roofline-tools-")), "t.db");
const db = createSqliteDb();
const org = DEMO_ORG_ID;
const origin = "https://roofline.custom.amoslabs.com";
const identity = (email: string, role: string): AmosIdentity =>
  ({ sub: `sub-${email}`, org_id: "aa193fa0-2229-415e-a609-35076a8afb01", email, role, plan_key: "", entitlements: [], subscription_status: "", app_id: "x", aud: "x" }) as unknown as AmosIdentity;

async function call(email: string, role: string, name: string, args: Record<string, unknown> = {}) {
  const ctx = await toolContext(db, org, identity(email, role), origin);
  return runTool(ctx, name, args);
}
const admin = (name: string, args?: Record<string, unknown>) => call("jeff@demo.roofline", "admin", name, args);
const ok = async (p: Promise<{ status: number; body: unknown }>) => {
  const r = await p;
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body as Record<string, any>;
};

test("publish payload: one flat path per tool, reads GET, writes POST", () => {
  const pub = publishPayload();
  assert.equal(pub.length, TOOLS.length);
  for (const t of pub) {
    assert.equal(t.http_path, `/api/tools/${t.name}`);
    assert.ok(!String(t.http_path).includes("{"), "no placeholders");
    assert.equal(t.http_method, t.classification === "read" ? "GET" : "POST");
  }
  assert.equal(new Set(pub.map((t) => t.name)).size, pub.length);
});

test("the whole job flow runs through the tools", async () => {
  const lead = await ok(admin("create_lead", { name: "Jordan Sample", address: "123 Sample Lane, Manchaca, TX 78652", email: "jordan@example.com" }));
  assert.equal(lead.stage, "New lead");
  const jobId = lead.job_id;
  await ok(admin("order_measurement", { job_id: jobId }));

  const proposal = await ok(admin("create_proposal", { job_id: jobId, from: "measurement" }));
  assert.ok(proposal.lines.length > 0);
  const pid = proposal.id;
  const added = await ok(admin("add_proposal_line", { proposal_id: pid, name: "Debris removal", section: "Clean Up", qty: 1, unit: "each", unit_price: 650, notes: "Magnetic sweep" }));
  const lineId = added.line_id;
  const updated = await ok(admin("update_proposal_line", { proposal_id: pid, line_id: lineId, qty: 2 }));
  assert.equal(updated.lines.find((l: any) => l.line_id === lineId).qty, 2);
  assert.equal(updated.lines.find((l: any) => l.line_id === lineId).unit_price_cents, 65000, "unchanged fields stay");
  const removed = await ok(admin("remove_proposal_line", { proposal_id: pid, line_id: lineId }));
  assert.ok(!removed.lines.some((l: any) => l.line_id === lineId));

  const sent = await ok(admin("send_proposal_for_signature", { proposal_id: pid }));
  assert.match(sent.signing_url, /^https:\/\/roofline\.custom\.amoslabs\.com\/sign\//);
  const frozen = await ok(admin("get_proposal", { proposal_id: pid }));
  assert.equal(frozen.signature.status, "Out for signature");
  assert.equal(frozen.editable, false);
  const blocked = await admin("add_proposal_line", { proposal_id: pid, name: "x" });
  assert.equal(blocked.status, 400);
  assert.match(JSON.stringify(blocked.body), /Void the signature request/);
  await ok(admin("void_signature_request", { proposal_id: pid, reason: "price change" }));

  const inv = await ok(admin("create_invoice", { proposal_id: pid, mode: "percent", percent: 50, send: true }));
  assert.equal(inv.invoice.title, "50% deposit");
  assert.match(inv.homeowner_link, /\/invoice\//);
  const total = (await ok(admin("get_proposal", { proposal_id: pid }))).billing.total_cents;
  const paid = await ok(admin("record_payment", { invoice_id: inv.invoice.id, amount: Number(inv.invoice.amount_cents) / 100, method: "Check", reference: "1042" }));
  assert.equal(paid.paid_in_full, true);
  const fin = await ok(admin("create_invoice", { proposal_id: pid, mode: "remaining" }));
  assert.equal(Number(fin.invoice.amount_cents), total - Number(inv.invoice.amount_cents));
  assert.equal((await admin("create_invoice", { proposal_id: pid, mode: "remaining" })).status, 400);

  const cost = await ok(admin("add_job_cost", { job_id: jobId, category: "materials", vendor: "SRS", amount: 4200.5 }));
  assert.equal(cost.money.actual_cost_cents, 420050);
  const money = await ok(admin("job_money", { job_id: jobId }));
  assert.equal(money.collected_cents, Number(inv.invoice.amount_cents));
  assert.equal(money.costs.length, 1);

  const listed = await ok(admin("list_invoices", { job_id: jobId }));
  assert.equal(listed.invoices.length, 2);
  const job = await ok(admin("get_job", { job_id: jobId }));
  assert.equal(job.proposals.length, 1);
  assert.equal(job.money.collected_cents, Number(inv.invoice.amount_cents));

  await ok(admin("add_catalog_item", { name: "Malarkey Vista AR", sku: "MAL-VISTA-AR", unit: "bundle", price: 45, section: "Malarkey Roofing Section" }));
  const cat = await ok(admin("list_catalog", { search: "Vista" }));
  assert.equal(cat.items[0].sku, "MAL-VISTA-AR");
  const viaSku = await ok(admin("create_proposal", { job_id: jobId, from: "blank" }));
  const withSku = await ok(admin("add_proposal_line", { proposal_id: viaSku.id, sku: "MAL-VISTA-AR", qty: 103 }));
  const l = withSku.proposal.lines[0];
  assert.deepEqual([l.name, l.unit, l.unit_price_cents, l.section], ["Malarkey Vista AR", "bundle", 4500, "Malarkey Roofing Section"]);

  const stage = await ok(admin("advance_job_stage", { job_id: jobId, stage: "Scheduled" }));
  assert.equal(stage.stage, "Scheduled");
  const summary = await ok(admin("pipeline_summary"));
  assert.equal(summary.stages.length, 8);
});

test("a rep sees only their own jobs", async () => {
  const marcus = (await db.get<{ id: number }>("SELECT id FROM users WHERE email = 'marcus@demo.roofline'"))!.id;
  const own = await db.get<{ id: number }>("SELECT id FROM jobs WHERE org_id = ? AND assignee_id = ? LIMIT 1", org, marcus);
  const other = await db.get<{ id: number }>("SELECT id FROM jobs WHERE org_id = ? AND assignee_id != ? LIMIT 1", org, marcus);
  const rep = (name: string, args?: Record<string, unknown>) => call("marcus@demo.roofline", "member", name, args);
  const listed = (await rep("list_jobs")).body as any;
  assert.ok(listed.jobs.length > 0 && listed.jobs.every((j: any) => j.rep === "Marcus Lee"));
  assert.equal((await rep("get_job", { job_id: own!.id })).status, 200);
  assert.equal((await rep("get_job", { job_id: other!.id })).status, 400, "another rep's job is not found");
  assert.equal((await rep("job_money", { job_id: other!.id })).status, 400);
});

test("bad input is a 400 with the reason; unknown tools 404", async () => {
  assert.equal((await admin("get_job", { job_id: "abc" })).status, 400);
  assert.equal((await admin("create_lead", { name: "x" })).status, 400);
  assert.equal((await admin("create_invoice", { proposal_id: 999999, mode: "percent", percent: 50 })).status, 400);
  assert.equal((await admin("record_payment", { invoice_id: 1, amount: "lots", method: "Check" })).status, 400);
  assert.equal((await admin("delete_everything")).status, 404);
});
