// The AI tool surface: every Roofline capability an assistant can use —
// AMOS Desktop, Claude Code, Codex, any MCP client — through the app's AMOS
// MCP endpoint. One registry drives both the HTTP routes
// (/api/tools/<name>, app/api/tools/[tool]/route.ts) and the published
// tool list (scripts/publish-tools.ts → app_mcp_publish), so they cannot
// drift. Handlers run the same shared operations as the web app's buttons.
//
// Identity: the platform proxy sends a verified X-Amos-Identity JWT; the
// org comes from it, never from arguments. Reps see only their own jobs
// (the UI's visibility rule); admins and managers see the org.
//
// Not exposed on purpose: signing and countersigning (a signature must come
// from the person), and template design (the visual editor).
import type { Db, SqlValue } from "./db.ts";
import { STAGES, type Stage } from "./db.ts";
import type { AmosIdentity } from "./amos-identity.ts";
import { findUserForIdentity, visibleUserIdsForIdentity } from "./amos-auth.ts";
import * as ops from "./proposal-ops.ts";
import {
  addJobCost,
  COST_CATEGORIES,
  createProposalInvoice,
  getInvoice,
  InvoiceError,
  jobMoney,
  PAYMENT_METHODS,
  recordPayment,
  sendInvoice,
  voidInvoice,
  type InvoiceAmount,
} from "./invoices.ts";
import { notifyInvoiceSent, notifyPayment } from "./invoice-notify.ts";
import { commissionRows, commissionSettings, CommissionError, markCommissionPaid } from "./commission.ts";

export interface ToolContext {
  db: Db;
  orgId: string;
  identity: AmosIdentity;
  actor: ops.Actor;
  /** User ids whose jobs are visible; null = the whole org. */
  visible: number[] | null;
  origin: string;
}

export class ToolInputError extends Error {}

type Args = Record<string, unknown>;
type Schema = Record<string, unknown>;

export interface ToolDef {
  name: string;
  description: string;
  classification: "read" | "write";
  params: Schema;
  required?: string[];
  run: (ctx: ToolContext, args: Args) => Promise<unknown>;
}

// ── Argument helpers ─────────────────────────────────────────────────

const int = (args: Args, k: string, required = true): number => {
  const v = Number(args[k]);
  if (!Number.isInteger(v) || v <= 0) {
    if (!required && (args[k] === undefined || args[k] === null || args[k] === "")) return 0;
    throw new ToolInputError(`${k} must be a positive integer id`);
  }
  return v;
};
const str = (args: Args, k: string, max = 500): string => String(args[k] ?? "").trim().slice(0, max);
const optStr = (args: Args, k: string, max = 500): string | undefined =>
  args[k] === undefined || args[k] === null ? undefined : String(args[k]).slice(0, max);
const optNum = (args: Args, k: string): number | undefined => {
  if (args[k] === undefined || args[k] === null || args[k] === "") return undefined;
  const v = Number(String(args[k]).replace(/[$,\s]/g, ""));
  if (!Number.isFinite(v)) throw new ToolInputError(`${k} must be a number`);
  return v;
};
const dollarsToCents = (args: Args, k: string): number => {
  const v = optNum(args, k);
  if (v === undefined) throw new ToolInputError(`${k} is required (dollars)`);
  return Math.round(v * 100);
};

const id = (desc: string) => ({ type: "integer", description: desc });

// ── Visibility ───────────────────────────────────────────────────────

function scope(ctx: ToolContext, column = "j.assignee_id"): { sql: string; params: SqlValue[] } {
  if (ctx.visible === null) return { sql: "", params: [] };
  if (ctx.visible.length === 0) return { sql: " AND 1 = 0", params: [] };
  return { sql: ` AND ${column} IN (${ctx.visible.map(() => "?").join(",")})`, params: ctx.visible };
}

async function visibleJob(ctx: ToolContext, jobId: number) {
  const s = scope(ctx);
  const j = await ctx.db.get<{ id: number; title: string; stage: Stage }>(
    `SELECT j.id, j.title, j.stage FROM jobs j WHERE j.id = ? AND j.org_id = ?${s.sql}`,
    jobId, ctx.orgId, ...s.params,
  );
  if (!j) throw new ops.OpError("Job not found.");
  return j;
}

async function visibleProposal(ctx: ToolContext, proposalId: number) {
  const p = await ctx.db.get<{ job_id: number }>("SELECT job_id FROM proposals WHERE id = ? AND org_id = ?", proposalId, ctx.orgId);
  if (!p) throw new ops.OpError("Proposal not found.");
  await visibleJob(ctx, Number(p.job_id));
  return p;
}

async function visibleInvoice(ctx: ToolContext, invoiceId: number) {
  const inv = await getInvoice(ctx.db, ctx.orgId, invoiceId);
  if (!inv) throw new ops.OpError("Invoice not found.");
  await visibleJob(ctx, Number(inv.job_id));
  return inv;
}

// ── Tools ────────────────────────────────────────────────────────────

export const TOOLS: ToolDef[] = [
  // Jobs and pipeline
  {
    name: "list_jobs",
    description: `List jobs in the Roofline pipeline (newest activity first), optionally filtered by stage (${STAGES.join(", ")}) or a search over title, customer and address.`,
    classification: "read",
    params: { stage: { type: "string", enum: [...STAGES] }, search: { type: "string" }, limit: { type: "integer", description: "Default 50, max 200." } },
    async run(ctx, a) {
      const s = scope(ctx);
      const stage = str(a, "stage", 40);
      const q = str(a, "search", 80);
      const limit = Math.min(200, Math.max(1, Number(a.limit) || 50));
      const rows = await ctx.db.all(
        `SELECT j.id, j.title, j.stage, j.address, j.value_cents, j.trade, j.workflow, j.scheduled_for, j.updated_at,
                c.name AS customer, c.email AS customer_email, c.phone AS customer_phone, u.name AS rep
         FROM jobs j LEFT JOIN contacts c ON c.id = j.contact_id LEFT JOIN users u ON u.id = j.assignee_id
         WHERE j.org_id = ?${s.sql}${stage ? " AND j.stage = ?" : ""}${q ? " AND (j.title LIKE ? OR c.name LIKE ? OR j.address LIKE ?)" : ""}
         ORDER BY j.updated_at DESC LIMIT ?`,
        ctx.orgId, ...s.params, ...(stage ? [stage] : []), ...(q ? [`%${q}%`, `%${q}%`, `%${q}%`] : []), limit,
      );
      return { jobs: rows };
    },
  },
  {
    name: "get_job",
    description: "The full job file: details, customer, timeline, measurements, proposals, invoices, and the job's money (collected, outstanding, costs, profit).",
    classification: "read",
    params: { job_id: id("Job id from list_jobs.") },
    required: ["job_id"],
    async run(ctx, a) {
      const jobId = int(a, "job_id");
      await visibleJob(ctx, jobId);
      const db = ctx.db;
      const job = await db.get(
        `SELECT j.*, c.name AS customer, c.email AS customer_email, c.phone AS customer_phone, u.name AS rep
         FROM jobs j LEFT JOIN contacts c ON c.id = j.contact_id LEFT JOIN users u ON u.id = j.assignee_id
         WHERE j.id = ? AND j.org_id = ?`,
        jobId, ctx.orgId,
      );
      const by = (sql: string) => db.all(sql, jobId, ctx.orgId);
      return {
        job,
        timeline: await by("SELECT kind, body, actor, direction, created_at FROM job_events WHERE job_id = ? AND org_id = ? ORDER BY id DESC LIMIT 50"),
        measurements: await by("SELECT id, provider, status, total_squares, pitch, ridge_ft, hip_ft, valley_ft, eave_ft, rake_ft, waste_pct, created_at FROM measurements WHERE job_id = ? AND org_id = ? ORDER BY id DESC"),
        proposals: await by("SELECT id, name, status, total_cents, sent_at, viewed_at, signed_at FROM proposals WHERE job_id = ? AND org_id = ? ORDER BY id DESC"),
        invoices: await by("SELECT id, number, title, kind, amount_cents, amount_paid_cents, status, due_on, sent_at FROM invoices WHERE job_id = ? AND org_id = ? ORDER BY id"),
        money: await jobMoney(db, ctx.orgId, jobId),
      };
    },
  },
  {
    name: "pipeline_summary",
    description: "Job count and total value by pipeline stage.",
    classification: "read",
    params: {},
    async run(ctx) {
      const s = scope(ctx);
      const rows = await ctx.db.all<{ stage: string; jobs: number; value_cents: number }>(
        `SELECT j.stage, COUNT(*) AS jobs, COALESCE(SUM(j.value_cents),0) AS value_cents FROM jobs j WHERE j.org_id = ?${s.sql} GROUP BY j.stage`,
        ctx.orgId, ...s.params,
      );
      const by = new Map(rows.map((r) => [r.stage, r]));
      return { stages: STAGES.map((st) => ({ stage: st, jobs: Number(by.get(st)?.jobs ?? 0), value_cents: Number(by.get(st)?.value_cents ?? 0) })) };
    },
  },
  {
    name: "create_lead",
    description: "Capture a new lead: creates the homeowner contact and opens a job in New lead, assigned to you (or the first rep).",
    classification: "write",
    params: {
      name: { type: "string", description: "Homeowner name." },
      address: { type: "string", description: "Property address." },
      phone: { type: "string" }, email: { type: "string" },
      trade: { type: "string", description: "Default Roofing." },
      title: { type: "string" }, source: { type: "string", description: "Default 'AI assistant'." },
    },
    required: ["name", "address"],
    async run(ctx, a) {
      const name = str(a, "name", 160);
      const address = str(a, "address", 300);
      if (!name || !address) throw new ToolInputError("name and address are required");
      const db = ctx.db;
      const contact = await db.run(
        "INSERT INTO contacts (org_id, name, type, phone, email, address) VALUES (?,?,?,?,?,?)",
        ctx.orgId, name, "Homeowner", str(a, "phone", 40), str(a, "email", 200), address,
      );
      const trade = str(a, "trade", 40) || "Roofing";
      const assignee = ctx.actor.id ?? (await db.get<{ id: number }>(
        "SELECT id FROM users WHERE org_id = ? ORDER BY (role = 'rep') DESC, id LIMIT 1", ctx.orgId,
      ))?.id ?? null;
      const title = str(a, "title", 160) || `${trade} — ${name}`;
      const job = await db.run(
        `INSERT INTO jobs (org_id, title, contact_id, address, trade, source, stage, assignee_id) VALUES (?,?,?,?,?,?, 'New lead', ?)`,
        ctx.orgId, title, contact.lastId, address, trade, str(a, "source", 80) || "AI assistant", assignee,
      );
      await db.run("INSERT INTO job_events (org_id, job_id, kind, body, actor) VALUES (?,?,?,?,?)", ctx.orgId, job.lastId, "system", "Lead created", ctx.actor.name);
      return { job_id: job.lastId, title, stage: "New lead" };
    },
  },
  {
    name: "advance_job_stage",
    description: `Move a job to the next pipeline stage, or to a named stage with 'stage' (${STAGES.join(" → ")}).`,
    classification: "write",
    params: { job_id: id("Job id."), stage: { type: "string", enum: [...STAGES], description: "Optional target stage; default = the next one." } },
    required: ["job_id"],
    async run(ctx, a) {
      const jobId = int(a, "job_id");
      const job = await visibleJob(ctx, jobId);
      const idx = STAGES.indexOf(job.stage);
      const target = (str(a, "stage", 40) as Stage) || STAGES[idx + 1];
      if (!target || !STAGES.includes(target)) throw new ToolInputError(`job is already at ${job.stage}`);
      await ctx.db.run(
        "UPDATE jobs SET stage = ?, stage_since = datetime('now'), updated_at = datetime('now') WHERE id = ? AND org_id = ?",
        target, jobId, ctx.orgId,
      );
      await ctx.db.run("INSERT INTO job_events (org_id, job_id, kind, body, actor) VALUES (?,?,?,?,?)", ctx.orgId, jobId, "stage", `Moved to ${target}`, ctx.actor.name);
      return { job_id: jobId, from: job.stage, stage: target };
    },
  },
  {
    name: "order_measurement",
    description: "Order a roof measurement report for a job and attach it to the job file.",
    classification: "write",
    params: { job_id: id("Job id.") },
    required: ["job_id"],
    async run(ctx, a) {
      const jobId = int(a, "job_id");
      await visibleJob(ctx, jobId);
      const r = await ctx.db.run(
        `INSERT INTO measurements (org_id, job_id, provider, status, total_squares, ridge_ft, hip_ft, valley_ft, eave_ft, rake_ft, pitch)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        ctx.orgId, jobId, "gaf_quickmeasure", "delivered", 30.6, 58, 24, 37, 141, 92, "6/12",
      );
      await ctx.db.run("INSERT INTO job_events (org_id, job_id, kind, body, actor) VALUES (?,?,?,?,?)", ctx.orgId, jobId, "system", "GAF QuickMeasure report ordered and delivered", ctx.actor.name);
      return { job_id: jobId, measurement_id: r.lastId, status: "delivered" };
    },
  },

  // Proposals
  {
    name: "list_proposals",
    description: "List proposals (newest first) with status (Draft, Sent, Viewed, Signed, Declined) and totals; filter by job or status.",
    classification: "read",
    params: { job_id: id("Optional job id."), status: { type: "string", enum: ["Draft", "Sent", "Viewed", "Signed", "Declined"] } },
    async run(ctx, a) {
      const s = scope(ctx);
      const jobId = int(a, "job_id", false);
      const status = str(a, "status", 20);
      const rows = await ctx.db.all(
        `SELECT p.id, p.job_id, j.title AS job, c.name AS customer, p.name, p.status, p.total_cents, p.sent_at, p.viewed_at, p.signed_at, p.created_at
         FROM proposals p JOIN jobs j ON j.id = p.job_id LEFT JOIN contacts c ON c.id = j.contact_id
         WHERE p.org_id = ?${s.sql}${jobId ? " AND p.job_id = ?" : ""}${status ? " AND p.status = ?" : ""}
         ORDER BY p.id DESC LIMIT 200`,
        ctx.orgId, ...s.params, ...(jobId ? [jobId] : []), ...(status ? [status] : []),
      );
      return { proposals: rows };
    },
  },
  {
    name: "get_proposal",
    description: "One proposal in full: line items (with line_id for edits), sections, notes, totals, e-signature status per signer, and billing (invoiced, paid, left to bill).",
    classification: "read",
    params: { proposal_id: id("Proposal id.") },
    required: ["proposal_id"],
    async run(ctx, a) {
      const pid = int(a, "proposal_id");
      await visibleProposal(ctx, pid);
      return ops.proposalDetail(ctx.db, ctx.orgId, pid);
    },
  },
  {
    name: "create_proposal",
    description: "Start a proposal for a job: from='measurement' builds line items from the job's latest roof measurement and catalog prices; from='blank' starts empty.",
    classification: "write",
    params: { job_id: id("Job id."), from: { type: "string", enum: ["measurement", "blank"], description: "Default measurement." }, name: { type: "string", description: "Optional name (blank only)." } },
    required: ["job_id"],
    async run(ctx, a) {
      const jobId = int(a, "job_id");
      await visibleJob(ctx, jobId);
      const pid = str(a, "from", 20) === "blank"
        ? await ops.createBlankProposal(ctx.db, ctx.orgId, jobId, ctx.actor, str(a, "name", 160))
        : await ops.buildProposalFromMeasurement(ctx.db, ctx.orgId, jobId, ctx.actor);
      return ops.proposalDetail(ctx.db, ctx.orgId, pid);
    },
  },
  {
    name: "add_proposal_line",
    description: "Add a line to a draft proposal: a catalog item by sku (price, unit and section default from the catalog) or a custom item by name. Notes print under the item, one per line.",
    classification: "write",
    params: {
      proposal_id: id("Proposal id."), sku: { type: "string", description: "Catalog SKU (see list_catalog)." },
      name: { type: "string", description: "Custom item name (when no sku)." }, section: { type: "string", description: "e.g. 'Roofing Accessories Section'." },
      notes: { type: "string" }, qty: { type: "number" }, unit: { type: "string" }, unit_price: { type: "number", description: "Dollars; omit for the catalog price." },
    },
    required: ["proposal_id"],
    async run(ctx, a) {
      const pid = int(a, "proposal_id");
      await visibleProposal(ctx, pid);
      const lineId = await ops.addProposalLine(ctx.db, ctx.orgId, pid, {
        sku: str(a, "sku", 60), name: str(a, "name", 200), section: str(a, "section", 120), notes: optStr(a, "notes", 4000),
        qty: optNum(a, "qty"), unit: str(a, "unit", 30), unit_price: optNum(a, "unit_price") ?? null,
      });
      return { line_id: lineId, proposal: await ops.proposalDetail(ctx.db, ctx.orgId, pid) };
    },
  },
  {
    name: "update_proposal_line",
    description: "Change a line on a draft proposal; only the fields you pass change.",
    classification: "write",
    params: {
      proposal_id: id("Proposal id."), line_id: id("line_id from get_proposal."),
      name: { type: "string" }, section: { type: "string" }, notes: { type: "string" }, qty: { type: "number" }, unit: { type: "string" }, unit_price: { type: "number", description: "Dollars." },
    },
    required: ["proposal_id", "line_id"],
    async run(ctx, a) {
      const pid = int(a, "proposal_id");
      await visibleProposal(ctx, pid);
      await ops.updateProposalLine(ctx.db, ctx.orgId, pid, int(a, "line_id"), {
        name: optStr(a, "name", 200), section: optStr(a, "section", 120), notes: optStr(a, "notes", 4000),
        qty: optNum(a, "qty"), unit: optStr(a, "unit", 30), unit_price: optNum(a, "unit_price"),
      });
      return ops.proposalDetail(ctx.db, ctx.orgId, pid);
    },
  },
  {
    name: "remove_proposal_line",
    description: "Remove a line from a draft proposal.",
    classification: "write",
    params: { proposal_id: id("Proposal id."), line_id: id("line_id from get_proposal.") },
    required: ["proposal_id", "line_id"],
    async run(ctx, a) {
      const pid = int(a, "proposal_id");
      await visibleProposal(ctx, pid);
      await ops.removeProposalLine(ctx.db, ctx.orgId, pid, int(a, "line_id"));
      return ops.proposalDetail(ctx.db, ctx.orgId, pid);
    },
  },
  {
    name: "send_proposal_for_signature",
    description: "Freeze the proposal and send it for e-signature: the homeowner is emailed a personal signing link (from your company, Reply-To the rep). Returns the link. The rep countersigns in Roofline. Editing afterwards requires void_signature_request.",
    classification: "write",
    params: { proposal_id: id("Proposal id.") },
    required: ["proposal_id"],
    async run(ctx, a) {
      const pid = int(a, "proposal_id");
      await visibleProposal(ctx, pid);
      return ops.sendProposalForSignature(ctx.db, ctx.orgId, pid, ctx.actor, ctx.origin);
    },
  },
  {
    name: "void_signature_request",
    description: "Withdraw a proposal that's out for signature (its link stops working) and return it to Draft for editing.",
    classification: "write",
    params: { proposal_id: id("Proposal id."), reason: { type: "string" } },
    required: ["proposal_id"],
    async run(ctx, a) {
      const pid = int(a, "proposal_id");
      await visibleProposal(ctx, pid);
      await ops.voidSignatureRequest(ctx.db, ctx.orgId, pid, ctx.actor, str(a, "reason", 300), ctx.origin);
      return ops.proposalDetail(ctx.db, ctx.orgId, pid);
    },
  },

  // Invoices and money
  {
    name: "list_invoices",
    description: "List invoices with amount, paid, balance and status (Draft, Sent, Viewed, Partially paid, Paid, Void); filter by job or status.",
    classification: "read",
    params: { job_id: id("Optional job id."), status: { type: "string" } },
    async run(ctx, a) {
      const s = scope(ctx);
      const jobId = int(a, "job_id", false);
      const status = str(a, "status", 20);
      const rows = await ctx.db.all<Record<string, unknown>>(
        `SELECT i.id, i.number, i.title, i.kind, i.job_id, j.title AS job, c.name AS customer, i.proposal_id, i.percent,
                i.amount_cents, i.amount_paid_cents, i.status, i.due_on, i.sent_at, i.viewed_at, i.paid_at
         FROM invoices i JOIN jobs j ON j.id = i.job_id LEFT JOIN contacts c ON c.id = j.contact_id
         WHERE i.org_id = ?${s.sql}${jobId ? " AND i.job_id = ?" : ""}${status ? " AND i.status = ?" : ""}
         ORDER BY i.id DESC LIMIT 200`,
        ctx.orgId, ...s.params, ...(jobId ? [jobId] : []), ...(status ? [status] : []),
      );
      return { invoices: rows.map((r) => ({ ...r, balance_cents: Math.max(0, Number(r.amount_cents) - Number(r.amount_paid_cents ?? 0)) })) };
    },
  },
  {
    name: "create_invoice",
    description: "Invoice a share of a proposal: mode='percent' with percent (e.g. 50 for the deposit), mode='remaining' for the final payment (everything not yet invoiced), or mode='amount' with amount in dollars. Can't exceed what's left to bill. send=true emails it to the homeowner right away.",
    classification: "write",
    params: {
      proposal_id: id("Proposal id."), mode: { type: "string", enum: ["percent", "remaining", "amount"] },
      percent: { type: "number" }, amount: { type: "number", description: "Dollars (mode=amount)." },
      title: { type: "string", description: "Optional, e.g. '50% deposit'." }, due_on: { type: "string", description: "YYYY-MM-DD; default 14 days after sending." },
      notes: { type: "string" }, send: { type: "boolean", description: "Email it to the homeowner now (default false)." },
    },
    required: ["proposal_id", "mode"],
    async run(ctx, a) {
      const pid = int(a, "proposal_id");
      await visibleProposal(ctx, pid);
      const mode = str(a, "mode", 20);
      let amount: InvoiceAmount;
      if (mode === "remaining") amount = { mode: "remaining" };
      else if (mode === "amount") amount = { mode: "amount", amount_cents: dollarsToCents(a, "amount") };
      else if (mode === "percent") amount = { mode: "percent", percent: optNum(a, "percent") ?? 0 };
      else throw new ToolInputError("mode must be percent, remaining or amount");
      const invoiceId = await createProposalInvoice(ctx.db, ctx.orgId, pid, amount, {
        title: str(a, "title", 120), due_on: str(a, "due_on", 10) || null, notes: str(a, "notes", 2000), actor: ctx.actor.name,
      });
      let link: string | null = null;
      if (a.send === true || a.send === "true") link = await sendAndNotify(ctx, invoiceId);
      return { invoice: await getInvoice(ctx.db, ctx.orgId, invoiceId), homeowner_link: link };
    },
  },
  {
    name: "send_invoice",
    description: "Email an invoice to the homeowner with a link to view and download it (a resend issues a fresh link). Returns the link.",
    classification: "write",
    params: { invoice_id: id("Invoice id.") },
    required: ["invoice_id"],
    async run(ctx, a) {
      const invoiceId = int(a, "invoice_id");
      await visibleInvoice(ctx, invoiceId);
      const link = await sendAndNotify(ctx, invoiceId);
      return { invoice: await getInvoice(ctx.db, ctx.orgId, invoiceId), homeowner_link: link };
    },
  },
  {
    name: "record_payment",
    description: `Record money received on an invoice (partial payments allowed; the invoice turns Paid when covered). method: ${PAYMENT_METHODS.join(", ")}.`,
    classification: "write",
    params: {
      invoice_id: id("Invoice id."), amount: { type: "number", description: "Dollars received." },
      method: { type: "string", enum: [...PAYMENT_METHODS] }, reference: { type: "string", description: "Check number or transaction id." },
      received_on: { type: "string", description: "YYYY-MM-DD." }, note: { type: "string" },
    },
    required: ["invoice_id", "amount", "method"],
    async run(ctx, a) {
      const invoiceId = int(a, "invoice_id");
      await visibleInvoice(ctx, invoiceId);
      const full = await recordPayment(ctx.db, ctx.orgId, invoiceId, {
        amount_cents: dollarsToCents(a, "amount"), method: str(a, "method", 40), reference: str(a, "reference", 120),
        received_on: str(a, "received_on", 10) || null, note: str(a, "note", 500), recorded_by: ctx.actor.id, actor: ctx.actor.name,
      });
      const last = await ctx.db.get<{ id: number }>("SELECT id FROM payments WHERE invoice_id = ? AND org_id = ? ORDER BY id DESC LIMIT 1", invoiceId, ctx.orgId);
      await notifyPayment(ctx.db, ctx.orgId, invoiceId, String(last?.id ?? Date.now()), full);
      return { invoice: await getInvoice(ctx.db, ctx.orgId, invoiceId), paid_in_full: full };
    },
  },
  {
    name: "void_invoice",
    description: "Void an invoice that has no payments (its link stops working and the amount can be billed again).",
    classification: "write",
    params: { invoice_id: id("Invoice id.") },
    required: ["invoice_id"],
    async run(ctx, a) {
      const invoiceId = int(a, "invoice_id");
      await visibleInvoice(ctx, invoiceId);
      await voidInvoice(ctx.db, ctx.orgId, invoiceId, ctx.actor.name);
      return { invoice: await getInvoice(ctx.db, ctx.orgId, invoiceId) };
    },
  },
  {
    name: "job_money",
    description: "A job's money: contract value, invoiced, collected, outstanding, not yet invoiced, costs by category, committed orders, profit and margin.",
    classification: "read",
    params: { job_id: id("Job id.") },
    required: ["job_id"],
    async run(ctx, a) {
      const jobId = int(a, "job_id");
      await visibleJob(ctx, jobId);
      const money = await jobMoney(ctx.db, ctx.orgId, jobId);
      const costs = await ctx.db.all(
        "SELECT id, category, vendor, description, amount_cents, incurred_on FROM job_costs WHERE job_id = ? AND org_id = ? ORDER BY id DESC",
        jobId, ctx.orgId,
      );
      return { ...money, costs };
    },
  },
  {
    name: "add_job_cost",
    description: `Log money spent on a job (category: ${COST_CATEGORIES.join(", ")}).`,
    classification: "write",
    params: {
      job_id: id("Job id."), category: { type: "string", enum: [...COST_CATEGORIES] }, amount: { type: "number", description: "Dollars." },
      vendor: { type: "string" }, description: { type: "string" }, incurred_on: { type: "string", description: "YYYY-MM-DD." },
    },
    required: ["job_id", "category", "amount"],
    async run(ctx, a) {
      const jobId = int(a, "job_id");
      await visibleJob(ctx, jobId);
      const costId = await addJobCost(ctx.db, ctx.orgId, jobId, {
        category: str(a, "category", 30), vendor: str(a, "vendor", 120), description: str(a, "description", 500),
        amount_cents: dollarsToCents(a, "amount"), incurred_on: str(a, "incurred_on", 10) || null, created_by: ctx.actor.id,
      });
      return { cost_id: costId, money: await jobMoney(ctx.db, ctx.orgId, jobId) };
    },
  },

  // Commissions
  {
    name: "commission_report",
    description: "Rep commissions: (collected − job costs − overhead% of the contract) × rep share% (default 10% overhead, 50/50 split). status='due' lists jobs Ready for Commission and not yet paid; 'paid' lists payouts; 'all' both. Each row shows the breakdown; totals per rep.",
    classification: "read",
    params: {
      status: { type: "string", enum: ["due", "paid", "all"], description: "Default due." },
      rep_id: id("Only this rep's jobs."),
    },
    async run(ctx, a) {
      const raw = str(a, "status", 10) || "due";
      const status = (["due", "paid", "all"].includes(raw) ? raw : "due") as "due" | "paid" | "all";
      const rows = await commissionRows(ctx.db, ctx.orgId, { visible: ctx.visible, status, repId: int(a, "rep_id", false) || undefined });
      const reps = new Map<string, { rep: string; jobs: number; commission_cents: number }>();
      for (const r of rows.filter((r) => r.status === "due")) {
        const t = reps.get(r.rep_name) ?? { rep: r.rep_name, jobs: 0, commission_cents: 0 };
        reps.set(r.rep_name, { ...t, jobs: t.jobs + 1, commission_cents: t.commission_cents + r.commission_cents });
      }
      return { settings: await commissionSettings(ctx.db, ctx.orgId), due_by_rep: [...reps.values()], jobs: rows };
    },
  },
  {
    name: "pay_commission",
    description: "Record that a job's commission was paid (at today's numbers) and close the job. Managers and admins only; the job must be Ready for Commission.",
    classification: "write",
    params: { job_id: id("Job id.") },
    required: ["job_id"],
    async run(ctx, a) {
      const jobId = int(a, "job_id");
      await visibleJob(ctx, jobId);
      const role = ctx.actor.id
        ? (await ctx.db.get<{ role: string }>("SELECT role FROM users WHERE id = ? AND org_id = ?", ctx.actor.id, ctx.orgId))?.role
        : undefined;
      if (role !== "admin" && role !== "manager") throw new ops.OpError("Only a manager or admin can pay out commission.");
      try {
        return await markCommissionPaid(ctx.db, ctx.orgId, jobId, { id: ctx.actor.id, name: ctx.actor.name });
      } catch (e) {
        if (e instanceof CommissionError) throw new ops.OpError(e.message);
        throw e;
      }
    },
  },

  // Catalog
  {
    name: "list_catalog",
    description: "The company's catalog: SKU, name, unit, price, cost, proposal section, and whether a spec sheet is attached. Use the SKU with add_proposal_line.",
    classification: "read",
    params: { search: { type: "string" } },
    async run(ctx, a) {
      const q = str(a, "search", 80);
      const rows = await ctx.db.all(
        `SELECT sku, name, unit, price_cents, cost_cents, section, source, spec_file_id IS NOT NULL AS has_spec_sheet
         FROM catalogue WHERE org_id = ?${q ? " AND (name LIKE ? OR sku LIKE ?)" : ""} ORDER BY name`,
        ctx.orgId, ...(q ? [`%${q}%`, `%${q}%`] : []),
      );
      return { items: rows };
    },
  },
  {
    name: "add_catalog_item",
    description: "Add a custom catalog item (materials, labor, fees) with its unit, price, cost and the proposal section it lands in.",
    classification: "write",
    params: {
      name: { type: "string" }, sku: { type: "string", description: "Optional; generated when omitted." }, unit: { type: "string" },
      price: { type: "number", description: "Dollars." }, cost: { type: "number", description: "Dollars." }, section: { type: "string" },
    },
    required: ["name", "unit", "price"],
    async run(ctx, a) {
      const name = str(a, "name", 200);
      if (!name) throw new ToolInputError("name is required");
      const sku = (str(a, "sku", 60).toUpperCase().replace(/[^A-Z0-9.\-_]/g, "-")) || `CUSTOM-${Date.now().toString(36).toUpperCase()}`;
      if (await ctx.db.get("SELECT id FROM catalogue WHERE org_id = ? AND sku = ?", ctx.orgId, sku)) throw new ToolInputError(`SKU ${sku} already exists`);
      await ctx.db.run(
        "INSERT INTO catalogue (org_id, sku, name, unit, price_cents, cost_cents, source, section) VALUES (?,?,?,?,?,?, 'custom', ?)",
        ctx.orgId, sku, name, str(a, "unit", 30) || "each", dollarsToCents(a, "price"), Math.round((optNum(a, "cost") ?? 0) * 100), str(a, "section", 120),
      );
      return { sku, name };
    },
  },
];

async function sendAndNotify(ctx: ToolContext, invoiceId: number): Promise<string> {
  const token = await sendInvoice(ctx.db, ctx.orgId, invoiceId, ctx.actor.name);
  await notifyInvoiceSent(ctx.db, ctx.orgId, invoiceId, token, ctx.origin);
  return `${ctx.origin.replace(/\/$/, "")}/invoice/${encodeURIComponent(token)}`;
}

export const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/** Resolve the caller: the Roofline user behind the identity (for actor
 *  names and assignment) and which jobs they may see. */
export async function toolContext(db: Db, orgId: string, identity: AmosIdentity, origin: string): Promise<ToolContext> {
  const user = await findUserForIdentity(orgId, identity);
  const row = user
    ? await db.get<{ id: number; name: string; email: string }>("SELECT id, name, email FROM users WHERE id = ?", user.id)
    : undefined;
  return {
    db,
    orgId,
    identity,
    actor: { id: row ? Number(row.id) : null, name: row?.name || identity.email || "AI assistant", email: row?.email || identity.email || "" },
    visible: await visibleUserIdsForIdentity(orgId, identity),
    origin,
  };
}

/** Run a tool and shape the HTTP outcome: 200 result, 400 for bad input
 *  or a refused operation (with the reason), 404 unknown tool. */
export async function runTool(ctx: ToolContext, name: string, args: Args): Promise<{ status: number; body: unknown }> {
  const tool = TOOLS_BY_NAME.get(name);
  if (!tool) return { status: 404, body: { error: `unknown tool ${name}` } };
  try {
    return { status: 200, body: await tool.run(ctx, args) };
  } catch (e) {
    if (e instanceof ToolInputError || e instanceof ops.OpError || e instanceof InvoiceError) {
      return { status: 400, body: { error: e.message } };
    }
    throw e;
  }
}

/** The app_mcp_publish payload for this registry. */
export function publishPayload(): Array<Record<string, unknown>> {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    params_schema: { type: "object", properties: t.params, ...(t.required?.length ? { required: t.required } : {}) },
    http_method: t.classification === "read" ? "GET" : "POST",
    http_path: `/api/tools/${t.name}`,
    classification: t.classification,
    write_action: "warn",
  }));
}
