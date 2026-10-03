/**
 * Commission tracking: the formula (collected − costs − 10% overhead, split
 * 50/50), due → paid → job closed, per-org settings, the 1st/15th statements
 * (company time zone, once per rep per period, only for AMOS-linked orgs),
 * and the AI tools.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteDb } from "../lib/db-sqlite.ts";
import { DEMO_ORG_ID } from "../lib/demo-fixtures.ts";
import type { AmosIdentity } from "../lib/amos-identity.ts";
import {
  commissionRows,
  commissionSettings,
  companyDate,
  computeCommission,
  isStatementDay,
  markCommissionPaid,
  saveCommissionSettings,
  sendCommissionStatements,
} from "../lib/commission.ts";
import { runTool, toolContext } from "../lib/tools.ts";

process.env.ROOFLINE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "roofline-comm-")), "t.db");
const db = createSqliteDb();
const org = DEMO_ORG_ID;
const origin = "https://roofline.custom.amoslabs.com";

async function userId(email: string): Promise<number> {
  return Number((await db.get<{ id: number }>("SELECT id FROM users WHERE email = ?", email))!.id);
}

/** A job Ready for Commission: contract $25,000 fully collected, $14,000 of costs. */
async function finishedJob(repEmail: string, title: string): Promise<number> {
  const rep = await userId(repEmail);
  const contact = (await db.get<{ id: number }>("SELECT id FROM contacts WHERE org_id = ? LIMIT 1", org))!.id;
  const job = await db.run(
    "INSERT INTO jobs (org_id, title, contact_id, address, trade, source, stage, assignee_id, value_cents, cost_cents) VALUES (?,?,?,?,?,?,?,?,?,?)",
    org, title, contact, "1 Main St, Austin, TX", "Roofing", "Referral", "Ready for Commission", rep, 2_500_000, 1_400_000,
  );
  await db.run(
    "INSERT INTO invoices (org_id, job_id, kind, amount_cents, amount_paid_cents, status) VALUES (?,?,?,?,?,?)",
    org, job.lastId, "Balance", 2_500_000, 2_500_000, "Paid",
  );
  for (const [category, cents] of [["materials", 900_000], ["labor", 500_000]] as const) {
    await db.run(
      "INSERT INTO job_costs (org_id, job_id, category, amount_cents) VALUES (?,?,?,?)",
      org, job.lastId, category, cents,
    );
  }
  return job.lastId;
}

test("the formula: collected − costs − 10% overhead, half the profit; a loss pays nothing", () => {
  const c = computeCommission({ contract_cents: 2_500_000, collected_cents: 2_500_000, actual_cost_cents: 1_400_000 }, { overhead_pct: 10, rep_share_pct: 50 });
  assert.deepEqual(c, {
    contract_cents: 2_500_000, income_cents: 2_500_000, expenses_cents: 1_400_000,
    overhead_cents: 250_000, profit_cents: 850_000, commission_cents: 425_000,
  });
  const loss = computeCommission({ contract_cents: 1_000_000, collected_cents: 1_000_000, actual_cost_cents: 1_200_000 }, { overhead_pct: 10, rep_share_pct: 50 });
  assert.equal(loss.profit_cents, -300_000);
  assert.equal(loss.commission_cents, 0);
});

test("a finished job is due, paying it records the amount and closes the job, once", async () => {
  const jobId = await finishedJob("marcus@demo.roofline", "Commission test roof");
  const due = (await commissionRows(db, org, { visible: null, status: "due" })).find((r) => r.job_id === jobId)!;
  assert.equal(due.commission_cents, 425_000);
  assert.equal(due.rep_name, "Marcus Lee");
  // A rep sees only their own jobs.
  const priya = await userId("priya@demo.roofline");
  assert.ok(!(await commissionRows(db, org, { visible: [priya], status: "due" })).some((r) => r.job_id === jobId));

  const paid = await markCommissionPaid(db, org, jobId, { id: await userId("jeff@demo.roofline"), name: "Jeff Barnes" });
  assert.equal(paid.paid_cents, 425_000);
  const job = await db.get<{ stage: string; commission_paid_cents: number }>("SELECT stage, commission_paid_cents FROM jobs WHERE id = ?", jobId);
  assert.equal(job!.stage, "Closed");
  assert.equal(Number(job!.commission_paid_cents), 425_000);
  assert.ok((await commissionRows(db, org, { visible: null, status: "paid" })).some((r) => r.job_id === jobId));
  await assert.rejects(markCommissionPaid(db, org, jobId, { id: null, name: "x" }), /already paid/);
  const notReady = (await db.get<{ id: number }>("SELECT id FROM jobs WHERE org_id = ? AND stage = 'New lead' LIMIT 1", org))!.id;
  await assert.rejects(markCommissionPaid(db, org, Number(notReady), { id: null, name: "x" }), /Ready for Commission/);
});

test("settings change the formula and are validated", async () => {
  await saveCommissionSettings(db, org, { overhead_pct: 12, rep_share_pct: 40, statements_enabled: true });
  assert.deepEqual(await commissionSettings(db, org), { overhead_pct: 12, rep_share_pct: 40, statements_enabled: true });
  await assert.rejects(saveCommissionSettings(db, org, { overhead_pct: 120, rep_share_pct: 40, statements_enabled: true }), /Overhead/);
  await saveCommissionSettings(db, org, { overhead_pct: 10, rep_share_pct: 50, statements_enabled: true });
});

test("statement days are the 1st and 15th in company time", () => {
  assert.equal(companyDate(new Date("2026-10-01T06:00:00Z")), "2026-10-01");
  assert.equal(companyDate(new Date("2026-10-01T03:00:00Z")), "2026-09-30"); // still Sept 30 in Texas
  assert.ok(isStatementDay("2026-10-01"));
  assert.ok(isStatementDay("2026-10-15"));
  assert.ok(!isStatementDay("2026-10-02"));
});

test("statements: one email per rep with jobs due, once per period, AMOS-linked orgs only", async () => {
  const jobId = await finishedJob("priya@demo.roofline", "Statement test roof");
  const fifteenth = new Date("2026-10-15T15:00:00Z");
  // Not linked to AMOS: nothing goes out.
  assert.equal((await sendCommissionStatements(db, org, { now: fifteenth, origin })).queued, 0);
  await db.run("UPDATE orgs SET amos_tenant_id = ? WHERE id = ?", "aa193fa0-2229-415e-a609-35076a8afb01", org);

  assert.equal((await sendCommissionStatements(db, org, { now: new Date("2026-10-14T15:00:00Z"), origin })).queued, 0);
  const sent = await sendCommissionStatements(db, org, { now: fifteenth, origin });
  assert.ok(sent.reps.some((r) => r.rep === "Priya Nair"));
  assert.equal(sent.queued, sent.reps.length);
  assert.equal((await sendCommissionStatements(db, org, { now: fifteenth, origin })).queued, 0, "once per period");

  const msg = await db.get<{ payload: string }>(
    "SELECT payload FROM amos_outbox WHERE topic = 'commission.statement' AND payload LIKE ? ORDER BY id DESC LIMIT 1",
    "%priya@demo.roofline%",
  );
  const p = JSON.parse(msg!.payload);
  assert.deepEqual(p.to, [{ email: "priya@demo.roofline" }]);
  assert.match(p.subject, /commission statement for 2026-10-15/);
  assert.match(p.text, /Statement test roof/);
  assert.match(p.text, /collected \$25,000\.00 − costs \$14,000\.00 − 10% overhead \$2,500\.00 = profit \$8,500\.00 → your 50%: \$4,250\.00/);
  assert.equal(p.cta.url, `${origin}/commissions`);

  // "Email statements now" sends off-cycle under its own key.
  const manual = await sendCommissionStatements(db, org, { now: new Date("2026-10-20T15:00:00Z"), origin, force: true });
  assert.ok(manual.queued >= 1);
  await db.run("UPDATE jobs SET stage = 'Closed', commission_paid_at = datetime('now') WHERE id = ?", jobId);
});

test("the AI tools report commissions and only managers can pay", async () => {
  const jobId = await finishedJob("marcus@demo.roofline", "Tool commission roof");
  const identity = (email: string, role: string) =>
    ({ sub: `sub-${email}`, org_id: "aa193fa0-2229-415e-a609-35076a8afb01", email, role, plan_key: "", entitlements: [], subscription_status: "", app_id: "x", aud: "x" }) as unknown as AmosIdentity;
  const call = async (email: string, role: string, name: string, args: Record<string, unknown>) =>
    runTool(await toolContext(db, org, identity(email, role), origin), name, args);

  const report = await call("jeff@demo.roofline", "admin", "commission_report", {});
  assert.equal(report.status, 200);
  const body = report.body as any;
  assert.ok(body.jobs.some((r: any) => r.job_id === jobId && r.commission_cents === 425_000));
  assert.ok(body.due_by_rep.some((r: any) => r.rep === "Marcus Lee"));

  const byRep = await call("marcus@demo.roofline", "member", "pay_commission", { job_id: jobId });
  assert.equal(byRep.status, 400);
  assert.match(JSON.stringify(byRep.body), /manager or admin/);
  const byAdmin = await call("jeff@demo.roofline", "admin", "pay_commission", { job_id: jobId });
  assert.equal(byAdmin.status, 200, JSON.stringify(byAdmin.body));
});
