"use server";

// Sender-side invoice + job-money actions. Org-scoped by the session user.
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getDb } from "./db";
import { currentUser, type User } from "./auth";
import { requestOrigin } from "./request-origin";
import { kickAmosOutbox } from "./amos-worker";
import { notifyInvoiceSent, notifyPayment } from "./invoice-notify";
import {
  addJobCost,
  createProposalInvoice,
  getInvoice,
  InvoiceError,
  recordPayment,
  sendInvoice,
  voidInvoice,
  type InvoiceAmount,
} from "./invoices";

async function requireUser(): Promise<User> {
  const user = await currentUser();
  if (!user) redirect("/login");
  return user;
}

const cents = (v: FormDataEntryValue | null) => {
  const n = Number(String(v ?? "").replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};
const text = (v: FormDataEntryValue | null, max: number) => String(v ?? "").trim().slice(0, max);

function back(formData: FormData, fallback: string): string {
  const to = text(formData.get("return_to"), 200);
  return to.startsWith("/") && !to.startsWith("//") ? to : fallback;
}

function refresh(jobId: number, proposalId?: number | null) {
  revalidatePath(`/jobs/${jobId}`);
  revalidatePath("/invoices");
  revalidatePath("/payments");
  if (proposalId) revalidatePath(`/proposals/${proposalId}`);
}

function fail(to: string, e: unknown): never {
  if (e instanceof InvoiceError) {
    redirect(`${to}${to.includes("?") ? "&" : "?"}invoice_error=${encodeURIComponent(e.message)}`);
  }
  throw e;
}

/** Create an invoice from a proposal: preset percent, custom percent,
 *  custom amount, or the remaining balance. Optionally send it right away. */
export async function createInvoiceAction(proposalId: number, formData: FormData) {
  const user = await requireUser();
  const db = getDb();
  const p = await db.get<{ job_id: number }>("SELECT job_id FROM proposals WHERE id = ? AND org_id = ?", proposalId, user.org_id);
  if (!p) redirect("/proposals");
  const to = back(formData, `/jobs/${p.job_id}`);
  const mode = text(formData.get("mode"), 20);
  let amount: InvoiceAmount;
  if (mode === "remaining") amount = { mode: "remaining" };
  else if (mode === "amount") amount = { mode: "amount", amount_cents: cents(formData.get("amount")) };
  else amount = { mode: "percent", percent: Number(formData.get("percent") || 0) };
  let id = 0;
  try {
    id = await createProposalInvoice(db, user.org_id, proposalId, amount, {
      title: text(formData.get("title"), 120),
      due_on: text(formData.get("due_on"), 10) || null,
      notes: text(formData.get("notes"), 2000),
      actor: user.name,
    });
  } catch (e) {
    fail(to, e);
  }
  if (formData.get("send") === "yes") await doSend(user, id);
  refresh(p.job_id, proposalId);
  redirect(to);
}

async function doSend(user: User, invoiceId: number): Promise<string> {
  const db = getDb();
  const token = await sendInvoice(db, user.org_id, invoiceId, user.name);
  await notifyInvoiceSent(db, user.org_id, invoiceId, token, await requestOrigin());
  kickAmosOutbox();
  return token;
}

/** Send (or resend with a fresh link) — emails the homeowner through AMOS. */
export async function sendInvoiceAction(invoiceId: number, formData: FormData) {
  const user = await requireUser();
  const inv = await getInvoice(getDb(), user.org_id, invoiceId);
  if (!inv) redirect("/invoices");
  const to = back(formData, `/jobs/${inv.job_id}`);
  let token = "";
  try {
    token = await doSend(user, invoiceId);
  } catch (e) {
    fail(to, e);
  }
  refresh(inv.job_id, inv.proposal_id);
  redirect(`${to}${to.includes("?") ? "&" : "?"}invoice_link=${encodeURIComponent(token)}&invoice_id=${invoiceId}`);
}

export async function recordPaymentAction(invoiceId: number, formData: FormData) {
  const user = await requireUser();
  const db = getDb();
  const inv = await getInvoice(db, user.org_id, invoiceId);
  if (!inv) redirect("/invoices");
  const to = back(formData, `/jobs/${inv.job_id}`);
  let full = false;
  try {
    full = await recordPayment(db, user.org_id, invoiceId, {
      amount_cents: cents(formData.get("amount")),
      method: text(formData.get("method"), 40),
      reference: text(formData.get("reference"), 120),
      received_on: text(formData.get("received_on"), 10) || null,
      note: text(formData.get("note"), 500),
      recorded_by: user.id,
      actor: user.name,
    });
  } catch (e) {
    fail(to, e);
  }
  const last = await db.get<{ id: number }>("SELECT id FROM payments WHERE invoice_id = ? AND org_id = ? ORDER BY id DESC LIMIT 1", invoiceId, user.org_id);
  await notifyPayment(db, user.org_id, invoiceId, String(last?.id ?? Date.now()), full);
  kickAmosOutbox();
  refresh(inv.job_id, inv.proposal_id);
  redirect(to);
}

export async function voidInvoiceAction(invoiceId: number, formData: FormData) {
  const user = await requireUser();
  const inv = await getInvoice(getDb(), user.org_id, invoiceId);
  if (!inv) redirect("/invoices");
  const to = back(formData, `/jobs/${inv.job_id}`);
  try {
    await voidInvoice(getDb(), user.org_id, invoiceId, user.name);
  } catch (e) {
    fail(to, e);
  }
  refresh(inv.job_id, inv.proposal_id);
  redirect(to);
}

export async function addJobCostAction(jobId: number, formData: FormData) {
  const user = await requireUser();
  const db = getDb();
  const job = await db.get<{ id: number }>("SELECT id FROM jobs WHERE id = ? AND org_id = ?", jobId, user.org_id);
  if (!job) redirect("/jobs");
  try {
    await addJobCost(db, user.org_id, jobId, {
      category: text(formData.get("category"), 30),
      vendor: text(formData.get("vendor"), 120),
      description: text(formData.get("description"), 500),
      amount_cents: cents(formData.get("amount")),
      incurred_on: text(formData.get("incurred_on"), 10) || null,
      created_by: user.id,
    });
  } catch (e) {
    fail(`/jobs/${jobId}`, e);
  }
  refresh(jobId);
  redirect(`/jobs/${jobId}#money`);
}

export async function deleteJobCostAction(jobId: number, costId: number) {
  const user = await requireUser();
  await getDb().run("DELETE FROM job_costs WHERE id = ? AND job_id = ? AND org_id = ?", costId, jobId, user.org_id);
  refresh(jobId);
  redirect(`/jobs/${jobId}#money`);
}
