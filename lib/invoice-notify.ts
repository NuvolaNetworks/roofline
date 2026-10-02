// Invoice messages to AMOS: the email that sends an invoice to the
// homeowner, and invoice.sent / invoice.paid / payment.received events so the
// tenant's automations (QuickBooks, reminders, commission) can act. Queued in
// the AMOS outbox like the signing messages; orgs not linked to AMOS queue
// nothing.
import type { Db } from "./db.ts";
import { enqueue } from "./amos-outbox.ts";
import { money } from "./proposal-model.ts";
import { loadInvoiceModel } from "./invoice-doc.ts";
import { getInvoice } from "./invoices.ts";

async function amosOrg(db: Db, orgId: string): Promise<string | null> {
  return (await db.get<{ a: string | null }>("SELECT amos_tenant_id AS a FROM orgs WHERE id = ?", orgId))?.a ?? null;
}

const first = (name: string) => name.trim().split(/\s+/)[0] || "there";

async function invoiceEvent(db: Db, orgId: string, amosOrgId: string, invoiceId: number, topic: string, key: string, extra: Record<string, unknown> = {}) {
  const inv = await getInvoice(db, orgId, invoiceId);
  if (!inv) return;
  const m = await loadInvoiceModel(db, orgId, inv);
  await enqueue(db, orgId, "event", topic, key, {
    kind: "event",
    idempotency_key: key,
    org_id: amosOrgId,
    topic,
    occurred_at: new Date().toISOString(),
    data: {
      invoice_id: Number(inv.id),
      number: inv.number,
      title: inv.title,
      job_id: Number(inv.job_id),
      proposal_id: inv.proposal_id ? Number(inv.proposal_id) : null,
      amount_cents: Number(inv.amount_cents),
      amount_paid_cents: Number(inv.amount_paid_cents),
      status: inv.status,
      due_on: inv.due_on,
      customer: m ? { name: m.customer.name, email: m.customer.email || null, address: m.customer.address } : null,
      ...extra,
    },
  });
}

export async function notifyInvoiceSent(db: Db, orgId: string, invoiceId: number, token: string, origin: string) {
  const amosOrgId = await amosOrg(db, orgId);
  if (!amosOrgId) return;
  const inv = await getInvoice(db, orgId, invoiceId);
  if (!inv) return;
  const m = await loadInvoiceModel(db, orgId, inv);
  if (!m) return;
  const company = m.branding.company_name || m.rep.company;
  const linkKey = token.slice(0, 12);
  await invoiceEvent(db, orgId, amosOrgId, invoiceId, "invoice.sent", `inv-${invoiceId}-sent-${linkKey}`);
  if (!m.customer.email) return;
  const key = `inv-${invoiceId}-email-${linkKey}`;
  await enqueue(db, orgId, "email", "invoice.sent", key, {
    kind: "email",
    idempotency_key: key,
    org_id: amosOrgId,
    topic: "invoice.sent",
    to: [{ email: m.customer.email }],
    subject: `${m.number} from ${company}: ${money(m.balance_cents)} due ${m.due_on}`,
    text: [
      `Hi ${first(m.customer.name)},`,
      "",
      `Here is your invoice for ${m.title.toLowerCase()} on ${m.proposal_name} — ${money(m.balance_cents)}, due ${m.due_on}.`,
      "",
      "You can view and download it, with payment instructions, using the link below.",
      "",
      "Questions? Just reply to this email.",
    ].join("\n"),
    cta: { label: "View invoice", url: `${origin.replace(/\/$/, "")}/invoice/${encodeURIComponent(token)}` },
    reply_to: m.rep.email || null,
  });
}

export async function notifyPayment(db: Db, orgId: string, invoiceId: number, paymentKey: string, fullyPaid: boolean) {
  const amosOrgId = await amosOrg(db, orgId);
  if (!amosOrgId) return;
  await invoiceEvent(db, orgId, amosOrgId, invoiceId, "payment.received", `inv-${invoiceId}-payment-${paymentKey}`);
  if (fullyPaid) await invoiceEvent(db, orgId, amosOrgId, invoiceId, "invoice.paid", `inv-${invoiceId}-paid`);
}
