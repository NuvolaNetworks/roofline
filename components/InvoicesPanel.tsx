// Invoices for a job (or one proposal): bill a share of the proposal, send
// it to the homeowner, record payments. Server component; every control is a
// server action form.
import { headers } from "next/headers";
import { getDb } from "@/lib/db";
import { balanceDue, PAYMENT_METHODS, proposalBilling, type InvoiceRow } from "@/lib/invoices";
import { createInvoiceAction, recordPaymentAction, sendInvoiceAction, voidInvoiceAction } from "@/lib/invoice-actions";
import { usd2, tone } from "@/lib/fmt";
import CopyButton from "./CopyButton";

const btn = "rounded-lg border border-[var(--card-border)] px-2.5 py-1 text-xs hover:bg-black/5";
const primary = "rounded-lg bg-[var(--accent)] px-3 py-1.5 text-sm text-white hover:bg-[var(--accent-light)]";
const input = "rounded-md border border-[var(--card-border)] bg-white px-2 py-1 text-sm";

export default async function InvoicesPanel({
  orgId,
  jobId,
  proposalId,
  returnTo,
  link,
  linkInvoiceId,
  error,
}: {
  orgId: string;
  jobId: number;
  /** Limit to one proposal (the proposal page); omit for the whole job. */
  proposalId?: number;
  returnTo: string;
  link?: string;
  linkInvoiceId?: number;
  error?: string;
}) {
  const db = getDb();
  const invoices = await db.all<InvoiceRow>(
    `SELECT * FROM invoices WHERE job_id = ? AND org_id = ? ${proposalId ? "AND proposal_id = ?" : ""} ORDER BY id`,
    ...(proposalId ? [jobId, orgId, proposalId] : [jobId, orgId]),
  );
  const proposals = await db.all<{ id: number; name: string; status: string }>(
    `SELECT id, name, status FROM proposals WHERE job_id = ? AND org_id = ? AND total_cents > 0 ${proposalId ? "AND id = ?" : ""}
     ORDER BY (status = 'Signed') DESC, id DESC`,
    ...(proposalId ? [jobId, orgId, proposalId] : [jobId, orgId]),
  );
  const billing = await Promise.all(proposals.map(async (p) => ({ ...p, b: (await proposalBilling(db, orgId, p.id))! })));
  const h = await headers();
  const origin = `${h.get("x-forwarded-proto") ?? "http"}://${h.get("x-forwarded-host") ?? h.get("host")}`;
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="space-y-3">
      {error ? <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</div> : null}
      {link ? (
        <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm">
          <div className="mb-1 font-medium">Invoice sent — homeowner link</div>
          <div className="mb-2 break-all font-mono text-xs">{`${origin}/invoice/${link}`}</div>
          <CopyButton value={`${origin}/invoice/${link}`} />
          <p className="mt-2 text-xs text-[var(--muted)]">Emailed to the homeowner when their address is on file. Shown once.</p>
        </div>
      ) : null}

      {invoices.length === 0 ? <p className="text-sm text-[var(--muted)]">No invoices yet.</p> : null}
      {invoices.map((i) => {
        const due = balanceDue(i);
        const isLink = linkInvoiceId === Number(i.id);
        return (
          <div key={i.id} className={`rounded-lg border p-3 text-sm ${isLink ? "border-blue-300" : "border-[var(--card-border)]"}`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <span className="font-medium">{i.number ?? `#${i.id}`}</span> · {i.title ?? i.kind}
                <span className="text-xs text-[var(--muted)]">
                  {i.due_on ? ` · due ${i.due_on}` : ""}
                  {i.viewed_at ? " · viewed" : ""}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className="tabular-nums">{usd2(Number(i.amount_cents))}</span>
                {Number(i.amount_paid_cents) > 0 && i.status !== "Paid" ? (
                  <span className="text-xs tabular-nums text-[var(--muted)]">({usd2(due)} due)</span>
                ) : null}
                <span className={`rounded-full px-2 py-0.5 text-[11px] ${tone(i.status === "Partially paid" ? "Viewed" : i.status === "Void" ? "Declined" : i.status)}`}>
                  {i.status}
                </span>
              </div>
            </div>
            {i.status !== "Void" ? (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {i.proposal_id ? <a href={`/invoices/${i.id}/pdf`} target="_blank" rel="noreferrer" className={btn}>PDF</a> : null}
                {i.status !== "Paid" && i.proposal_id ? (
                  <form action={sendInvoiceAction.bind(null, Number(i.id))}>
                    <input type="hidden" name="return_to" value={returnTo} />
                    <button className={i.status === "Draft" ? "rounded-lg bg-[var(--accent)] px-2.5 py-1 text-xs text-white" : btn}>
                      {i.status === "Draft" ? "Send to homeowner" : "Resend (new link)"}
                    </button>
                  </form>
                ) : null}
                {i.status !== "Paid" ? (
                  <details className="w-full">
                    <summary className="cursor-pointer text-xs text-[var(--accent-light)]">Record a payment</summary>
                    <form action={recordPaymentAction.bind(null, Number(i.id))} className="mt-2 flex flex-wrap items-end gap-2">
                      <input type="hidden" name="return_to" value={returnTo} />
                      <label className="flex flex-col text-[11px] text-[var(--muted)]">Amount
                        <input name="amount" defaultValue={(due / 100).toFixed(2)} className={`${input} w-28 text-right`} />
                      </label>
                      <label className="flex flex-col text-[11px] text-[var(--muted)]">Method
                        <select name="method" className={input} defaultValue="Check">
                          {PAYMENT_METHODS.map((m) => <option key={m}>{m}</option>)}
                        </select>
                      </label>
                      <label className="flex flex-col text-[11px] text-[var(--muted)]">Check # / reference
                        <input name="reference" className={`${input} w-32`} />
                      </label>
                      <label className="flex flex-col text-[11px] text-[var(--muted)]">Received
                        <input type="date" name="received_on" defaultValue={today} className={input} />
                      </label>
                      <button className={btn}>Record</button>
                    </form>
                  </details>
                ) : null}
                {Number(i.amount_paid_cents) === 0 && i.status !== "Paid" ? (
                  <form action={voidInvoiceAction.bind(null, Number(i.id))}>
                    <input type="hidden" name="return_to" value={returnTo} />
                    <button className={`${btn} text-red-700`}>Void</button>
                  </form>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}

      {billing.map(({ id, name, status, b }) =>
        b.unbilled_cents > 0 ? (
          <form key={id} action={createInvoiceAction.bind(null, id)} className="space-y-2 rounded-lg border border-dashed border-[var(--card-border)] p-3 text-sm">
            <input type="hidden" name="return_to" value={returnTo} />
            <div className="flex flex-wrap justify-between gap-2">
              <span className="font-medium">
                New invoice{proposalId ? "" : ` · ${name}`}
                {status !== "Signed" ? <span className="text-xs text-amber-700"> (proposal not signed yet)</span> : null}
              </span>
              <span className="text-xs text-[var(--muted)]">
                {usd2(b.total_cents)} contract · {usd2(b.invoiced_cents)} invoiced · {usd2(b.unbilled_cents)} left to bill
              </span>
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <label className="flex flex-col text-[11px] text-[var(--muted)]">Bill
                <select name="mode" defaultValue={b.invoiced_cents === 0 ? "percent" : "remaining"} className={input}>
                  <option value="percent">A percent of the total</option>
                  <option value="remaining">The remaining balance ({usd2(b.unbilled_cents)})</option>
                  <option value="amount">A fixed amount</option>
                </select>
              </label>
              <label className="flex flex-col text-[11px] text-[var(--muted)]">Percent
                <input name="percent" defaultValue="50" className={`${input} w-16 text-right`} />
              </label>
              <label className="flex flex-col text-[11px] text-[var(--muted)]">Amount
                <input name="amount" placeholder="$" className={`${input} w-24 text-right`} />
              </label>
              <label className="flex flex-col text-[11px] text-[var(--muted)]">Title (optional)
                <input name="title" placeholder={b.invoiced_cents === 0 ? "50% deposit" : "Final payment"} className={`${input} w-40`} />
              </label>
              <label className="flex flex-col text-[11px] text-[var(--muted)]">Due
                <input type="date" name="due_on" className={input} />
              </label>
            </div>
            <div className="flex flex-wrap gap-2">
              <button name="send" value="yes" className={primary}>Create &amp; send</button>
              <button name="send" value="no" className="rounded-lg border border-[var(--card-border)] px-3 py-1.5 text-sm hover:bg-black/5">Save as draft</button>
            </div>
          </form>
        ) : null,
      )}
    </div>
  );
}
