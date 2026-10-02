// Invoices from proposals, payments, and the job's money picture.
//
// An invoice bills a share of a proposal's total: a percent (the 50%
// deposit), a fixed amount, or "the rest" (the final payment). It is sent to
// the homeowner by a random link (hash stored, 60-day expiry — same pattern
// as e-signature) and paid in one or more recorded payments. The job's
// money view adds the money-out side (job_costs) so contract value,
// invoiced, collected, outstanding, costs and profit sit in one place.
//
// No Next imports; actions revalidate and notify.
import { randomBytes, createHash } from "node:crypto";
import type { Db } from "./db.ts";
import { logJobEvent } from "./proposal-effects.ts";

export const INVOICE_LINK_DAYS = 60;
export const PAYMENT_METHODS = ["Check", "ACH / bank transfer", "Card", "Cash", "Financing", "Insurance check", "Other"] as const;
export const COST_CATEGORIES = ["materials", "labor", "subcontractor", "permit", "disposal", "equipment", "other"] as const;

export class InvoiceError extends Error {}

export interface InvoiceRow {
  id: number;
  org_id: string;
  job_id: number;
  proposal_id: number | null;
  kind: string;
  number: string | null;
  title: string | null;
  percent: number | null;
  notes: string;
  amount_cents: number;
  amount_paid_cents: number;
  status: string;
  due_on: string | null;
  sent_at: string | null;
  viewed_at: string | null;
  paid_at: string | null;
  voided_at: string | null;
  created_at: string;
}

export const invoiceNumber = (id: number) => `INV-${String(id).padStart(5, "0")}`;
export const balanceDue = (i: Pick<InvoiceRow, "amount_cents" | "amount_paid_cents">) =>
  Math.max(0, Number(i.amount_cents) - Number(i.amount_paid_cents));

function hashToken(t: string): string {
  return createHash("sha256").update(t, "utf8").digest("hex");
}

/** How much of a proposal is billed, collected, and still unbilled. */
export async function proposalBilling(db: Db, orgId: string, proposalId: number) {
  const p = await db.get<{ total_cents: number; status: string; name: string }>(
    "SELECT total_cents, status, name FROM proposals WHERE id = ? AND org_id = ?",
    proposalId, orgId,
  );
  if (!p) return null;
  const sums = await db.get<{ invoiced: number; paid: number }>(
    `SELECT COALESCE(SUM(amount_cents),0) AS invoiced, COALESCE(SUM(amount_paid_cents),0) AS paid
     FROM invoices WHERE proposal_id = ? AND org_id = ? AND status != 'Void'`,
    proposalId, orgId,
  );
  const total = Number(p.total_cents);
  const invoiced = Number(sums?.invoiced ?? 0);
  return {
    name: p.name,
    status: p.status,
    total_cents: total,
    invoiced_cents: invoiced,
    paid_cents: Number(sums?.paid ?? 0),
    unbilled_cents: Math.max(0, total - invoiced),
  };
}

export type InvoiceAmount =
  | { mode: "percent"; percent: number }
  | { mode: "amount"; amount_cents: number }
  | { mode: "remaining" };

export async function createProposalInvoice(
  db: Db,
  orgId: string,
  proposalId: number,
  amount: InvoiceAmount,
  opts: { title?: string; due_on?: string | null; notes?: string; actor: string },
): Promise<number> {
  const billing = await proposalBilling(db, orgId, proposalId);
  if (!billing) throw new InvoiceError("Proposal not found.");
  if (billing.total_cents <= 0) throw new InvoiceError("This proposal has no total to invoice yet.");
  let cents: number;
  let percent: number | null = null;
  let title = opts.title?.trim() || "";
  switch (amount.mode) {
    case "percent":
      if (!(amount.percent > 0 && amount.percent <= 100)) throw new InvoiceError("Percent must be between 0 and 100.");
      percent = Math.round(amount.percent * 100) / 100;
      cents = Math.round((billing.total_cents * percent) / 100);
      title ||= `${percent}% ${percent === 50 && billing.invoiced_cents === 0 ? "deposit" : "progress payment"}`;
      break;
    case "amount":
      if (!(amount.amount_cents > 0)) throw new InvoiceError("Enter an amount greater than zero.");
      cents = Math.round(amount.amount_cents);
      title ||= "Progress payment";
      break;
    case "remaining":
      cents = billing.unbilled_cents;
      if (cents <= 0) throw new InvoiceError("Everything on this proposal is already invoiced.");
      percent = Math.round((cents / billing.total_cents) * 10000) / 100;
      title ||= billing.invoiced_cents > 0 ? "Final payment" : "Full payment";
      break;
  }
  if (cents > billing.unbilled_cents) {
    throw new InvoiceError(
      `That's more than the ${(billing.unbilled_cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })} not yet invoiced on this proposal.`,
    );
  }
  const job = await db.get<{ job_id: number }>("SELECT job_id FROM proposals WHERE id = ? AND org_id = ?", proposalId, orgId);
  const kind = amount.mode === "remaining" && billing.invoiced_cents > 0 ? "Balance" : billing.invoiced_cents === 0 ? "Deposit" : "Progress";
  const r = await db.run(
    `INSERT INTO invoices (org_id, job_id, proposal_id, kind, title, percent, notes, amount_cents, status, due_on)
     VALUES (?,?,?,?,?,?,?,?, 'Draft', ?)`,
    orgId, job!.job_id, proposalId, kind, title, percent, opts.notes?.trim() ?? "", cents, opts.due_on || null,
  );
  await db.run("UPDATE invoices SET number = ? WHERE id = ? AND org_id = ?", invoiceNumber(r.lastId), r.lastId, orgId);
  await logJobEvent(db, orgId, job!.job_id, "system", `${invoiceNumber(r.lastId)} drafted: ${title}`, opts.actor);
  return r.lastId;
}

export async function getInvoice(db: Db, orgId: string, id: number): Promise<InvoiceRow | undefined> {
  return db.get<InvoiceRow>("SELECT * FROM invoices WHERE id = ? AND org_id = ?", id, orgId);
}

/** Issue (or re-issue) the homeowner link and mark the invoice sent.
 *  Returns the raw token — shown/emailed once, never stored. */
export async function sendInvoice(db: Db, orgId: string, id: number, actor: string): Promise<string> {
  const inv = await getInvoice(db, orgId, id);
  if (!inv) throw new InvoiceError("Invoice not found.");
  if (inv.status === "Void") throw new InvoiceError("This invoice was voided.");
  const token = randomBytes(32).toString("base64url");
  await db.run(
    `UPDATE invoices SET token_hash = ?, token_expires_at = datetime('now', ?),
            status = CASE WHEN status IN ('Draft') THEN 'Sent' ELSE status END,
            sent_at = COALESCE(sent_at, datetime('now')),
            due_on = COALESCE(due_on, date('now', '+14 days'))
     WHERE id = ? AND org_id = ?`,
    hashToken(token), `+${INVOICE_LINK_DAYS} days`, id, orgId,
  );
  await logJobEvent(db, orgId, inv.job_id, "email", `${inv.number ?? invoiceNumber(id)} sent to the homeowner`, actor, "outbound");
  await advanceStageForInvoice(db, orgId, inv);
  return token;
}

/** An invoice by its homeowner link (expired / voided → null). */
export async function invoiceForToken(db: Db, token: string): Promise<InvoiceRow | null> {
  if (!token || token.length > 100) return null;
  const inv = await db.get<InvoiceRow & { token_expires_at: string | null }>(
    "SELECT * FROM invoices WHERE token_hash = ?",
    hashToken(token),
  );
  if (!inv || inv.status === "Void") return null;
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");
  if (inv.token_expires_at && inv.token_expires_at < now && inv.status !== "Paid") return null;
  return inv;
}

export async function recordInvoiceView(db: Db, inv: InvoiceRow): Promise<boolean> {
  const r = await db.run(
    "UPDATE invoices SET viewed_at = datetime('now'), status = CASE WHEN status = 'Sent' THEN 'Viewed' ELSE status END WHERE id = ? AND org_id = ? AND viewed_at IS NULL",
    inv.id, inv.org_id,
  );
  if (r.changes) await logJobEvent(db, inv.org_id, inv.job_id, "email", `${inv.number} viewed by the homeowner`, "homeowner", "inbound");
  return r.changes > 0;
}

export interface PaymentInput {
  amount_cents: number;
  method: string;
  reference: string;
  received_on: string | null;
  note: string;
  recorded_by: number | null;
  actor: string;
}

/** Record a payment against an invoice. Partial payments leave it
 *  "Partially paid"; reaching the amount marks it Paid. Returns whether the
 *  invoice is now fully paid. */
export async function recordPayment(db: Db, orgId: string, invoiceId: number, p: PaymentInput): Promise<boolean> {
  const inv = await getInvoice(db, orgId, invoiceId);
  if (!inv) throw new InvoiceError("Invoice not found.");
  if (inv.status === "Void") throw new InvoiceError("This invoice was voided.");
  if (!(p.amount_cents > 0)) throw new InvoiceError("Enter the amount received.");
  const due = balanceDue(inv);
  if (p.amount_cents > due) {
    throw new InvoiceError(`That's more than the ${(due / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })} still due on this invoice.`);
  }
  const method = (PAYMENT_METHODS as readonly string[]).includes(p.method) ? p.method : "Other";
  await db.run(
    "INSERT INTO payments (org_id, invoice_id, amount_cents, method, reference, received_on, note, recorded_by) VALUES (?,?,?,?,?,?,?,?)",
    orgId, invoiceId, Math.round(p.amount_cents), method, p.reference.slice(0, 120) || null, p.received_on || null, p.note.slice(0, 500), p.recorded_by,
  );
  const paidNow = Number(inv.amount_paid_cents) + Math.round(p.amount_cents);
  const full = paidNow >= Number(inv.amount_cents);
  await db.run(
    `UPDATE invoices SET amount_paid_cents = ?, status = ?, paid_at = ${full ? "datetime('now')" : "paid_at"} WHERE id = ? AND org_id = ?`,
    paidNow, full ? "Paid" : "Partially paid", invoiceId, orgId,
  );
  const money = (c: number) => (c / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
  await logJobEvent(db, orgId, inv.job_id, "system", `${money(p.amount_cents)} received (${method}) on ${inv.number}${full ? " — paid in full" : ""}`, p.actor);
  if (full) await advanceStageForInvoice(db, orgId, { ...inv, status: "Paid" });
  return full;
}

export async function voidInvoice(db: Db, orgId: string, invoiceId: number, actor: string): Promise<void> {
  const inv = await getInvoice(db, orgId, invoiceId);
  if (!inv) throw new InvoiceError("Invoice not found.");
  if (Number(inv.amount_paid_cents) > 0) throw new InvoiceError("Payments were recorded on this invoice; it can't be voided.");
  await db.run(
    "UPDATE invoices SET status = 'Void', voided_at = datetime('now'), token_hash = NULL WHERE id = ? AND org_id = ?",
    invoiceId, orgId,
  );
  await logJobEvent(db, orgId, inv.job_id, "system", `${inv.number} voided`, actor);
}

const STAGE_ORDER = ["New lead", "Assigned lead", "Prospect", "Approved", "Scheduled", "Completed/Invoiced", "Ready for Commission", "Closed"];

/** Move the job forward (never back): sending the final invoice →
 *  Completed/Invoiced; the proposal fully invoiced and every one of its
 *  invoices paid → Ready for Commission. */
async function advanceStageForInvoice(db: Db, orgId: string, inv: InvoiceRow): Promise<void> {
  const job = await db.get<{ stage: string }>("SELECT stage FROM jobs WHERE id = ? AND org_id = ?", inv.job_id, orgId);
  if (!job) return;
  let target: string | null = null;
  if (inv.status === "Paid" && inv.proposal_id) {
    const b = await proposalBilling(db, orgId, Number(inv.proposal_id));
    const open = await db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM invoices WHERE proposal_id = ? AND org_id = ? AND status NOT IN ('Paid','Void')",
      inv.proposal_id, orgId,
    );
    if (b && b.unbilled_cents === 0 && Number(open?.n ?? 0) === 0) target = "Ready for Commission";
  } else if (inv.kind === "Balance") {
    target = "Completed/Invoiced";
  }
  if (!target || STAGE_ORDER.indexOf(target) <= STAGE_ORDER.indexOf(job.stage)) return;
  await db.run(
    "UPDATE jobs SET stage = ?, stage_since = datetime('now'), updated_at = datetime('now') WHERE id = ? AND org_id = ?",
    target, inv.job_id, orgId,
  );
  await logJobEvent(db, orgId, inv.job_id, "stage", `Moved to ${target}`, "invoicing");
}

// ── Job money ─────────────────────────────────────────────────────────

export async function addJobCost(
  db: Db,
  orgId: string,
  jobId: number,
  c: { category: string; vendor: string; description: string; amount_cents: number; incurred_on: string | null; created_by: number | null },
): Promise<number> {
  if (!(c.amount_cents > 0)) throw new InvoiceError("Enter the cost amount.");
  const category = (COST_CATEGORIES as readonly string[]).includes(c.category) ? c.category : "other";
  const r = await db.run(
    "INSERT INTO job_costs (org_id, job_id, category, vendor, description, amount_cents, incurred_on, created_by) VALUES (?,?,?,?,?,?,?,?)",
    orgId, jobId, category, c.vendor.slice(0, 120), c.description.slice(0, 500), Math.round(c.amount_cents), c.incurred_on || null, c.created_by,
  );
  return r.lastId;
}

export async function jobMoney(db: Db, orgId: string, jobId: number) {
  const job = await db.get<{ value_cents: number; cost_cents: number }>("SELECT value_cents, cost_cents FROM jobs WHERE id = ? AND org_id = ?", jobId, orgId);
  const inv = await db.get<{ invoiced: number; collected: number }>(
    // Drafts aren't owed yet: they count as "not invoiced" until sent.
    `SELECT COALESCE(SUM(amount_cents),0) AS invoiced, COALESCE(SUM(amount_paid_cents),0) AS collected
     FROM invoices WHERE job_id = ? AND org_id = ? AND status NOT IN ('Void', 'Draft')`,
    jobId, orgId,
  );
  const costs = await db.all<{ category: string; total: number }>(
    "SELECT category, COALESCE(SUM(amount_cents),0) AS total FROM job_costs WHERE job_id = ? AND org_id = ? GROUP BY category ORDER BY category",
    jobId, orgId,
  );
  const committed = await db.get<{ materials: number; work: number }>(
    `SELECT (SELECT COALESCE(SUM(total_cents),0) FROM material_orders WHERE job_id = ? AND org_id = ? AND status != 'Draft') AS materials,
            (SELECT COALESCE(SUM(amount_cents),0) FROM work_orders WHERE job_id = ? AND org_id = ?) AS work`,
    jobId, orgId, jobId, orgId,
  );
  const contract = Number(job?.value_cents ?? 0);
  const actualCosts = costs.reduce((s, c) => s + Number(c.total), 0);
  const invoiced = Number(inv?.invoiced ?? 0);
  const collected = Number(inv?.collected ?? 0);
  return {
    contract_cents: contract,
    estimated_cost_cents: Number(job?.cost_cents ?? 0),
    invoiced_cents: invoiced,
    collected_cents: collected,
    outstanding_cents: Math.max(0, invoiced - collected),
    unbilled_cents: Math.max(0, contract - invoiced),
    costs_by_category: costs.map((c) => ({ category: c.category, total_cents: Number(c.total) })),
    actual_cost_cents: actualCosts,
    committed_cents: Number(committed?.materials ?? 0) + Number(committed?.work ?? 0),
    profit_cents: contract - actualCosts,
    cash_position_cents: collected - actualCosts,
  };
}
