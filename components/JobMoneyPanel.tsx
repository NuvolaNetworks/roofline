// The job's money: contract, invoiced, collected, outstanding, costs by
// category, profit — and a log of money out (job_costs).
import { getDb } from "@/lib/db";
import { COST_CATEGORIES, jobMoney } from "@/lib/invoices";
import { addJobCostAction, deleteJobCostAction } from "@/lib/invoice-actions";
import { usd2 } from "@/lib/fmt";

const input = "rounded-md border border-[var(--card-border)] bg-white px-2 py-1 text-sm";

export default async function JobMoneyPanel({ orgId, jobId }: { orgId: string; jobId: number }) {
  const db = getDb();
  const m = await jobMoney(db, orgId, jobId);
  const costs = await db.all<{ id: number; category: string; vendor: string; description: string; amount_cents: number; incurred_on: string | null }>(
    "SELECT id, category, vendor, description, amount_cents, incurred_on FROM job_costs WHERE job_id = ? AND org_id = ? ORDER BY COALESCE(incurred_on, created_at) DESC, id DESC",
    jobId, orgId,
  );
  const margin = m.contract_cents > 0 ? Math.round((m.profit_cents / m.contract_cents) * 100) : 0;
  const stat = (label: string, value: string, note?: string) => (
    <div className="rounded-lg border border-[var(--card-border)] p-2">
      <div className="text-[11px] uppercase tracking-wide text-[var(--muted)]">{label}</div>
      <div className="font-semibold tabular-nums">{value}</div>
      {note ? <div className="text-[11px] text-[var(--muted)]">{note}</div> : null}
    </div>
  );
  return (
    <div id="money" className="space-y-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {stat("Contract", usd2(m.contract_cents), m.unbilled_cents ? `${usd2(m.unbilled_cents)} not invoiced` : "fully invoiced")}
        {stat("Collected", usd2(m.collected_cents), m.outstanding_cents ? `${usd2(m.outstanding_cents)} outstanding` : "nothing outstanding")}
        {stat("Costs so far", usd2(m.actual_cost_cents), m.estimated_cost_cents ? `estimate ${usd2(m.estimated_cost_cents)}` : undefined)}
        {stat("Profit", usd2(m.profit_cents), m.contract_cents ? `${margin}% margin · cash ${usd2(m.cash_position_cents)}` : undefined)}
      </div>
      {m.costs_by_category.length ? (
        <div className="flex flex-wrap gap-2 text-xs text-[var(--muted)]">
          {m.costs_by_category.map((c) => (
            <span key={c.category} className="rounded-full bg-black/5 px-2 py-0.5">{c.category} {usd2(c.total_cents)}</span>
          ))}
          {m.committed_cents ? <span className="rounded-full bg-amber-50 px-2 py-0.5 text-amber-800">orders committed {usd2(m.committed_cents)}</span> : null}
        </div>
      ) : null}
      <form action={addJobCostAction.bind(null, jobId)} className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col text-[11px] text-[var(--muted)]">Cost
          <select name="category" className={input} defaultValue="materials">
            {COST_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <label className="flex flex-col text-[11px] text-[var(--muted)]">Vendor / payee
          <input name="vendor" placeholder="SRS, crew, city…" className={`${input} w-36`} />
        </label>
        <label className="flex flex-col text-[11px] text-[var(--muted)]">What for
          <input name="description" className={`${input} w-44`} />
        </label>
        <label className="flex flex-col text-[11px] text-[var(--muted)]">Amount
          <input name="amount" placeholder="$" className={`${input} w-24 text-right`} />
        </label>
        <label className="flex flex-col text-[11px] text-[var(--muted)]">Date
          <input type="date" name="incurred_on" defaultValue={new Date().toISOString().slice(0, 10)} className={input} />
        </label>
        <button className="rounded-lg border border-[var(--card-border)] px-3 py-1.5 text-sm hover:bg-black/5">Add cost</button>
      </form>
      {costs.length ? (
        <ul className="divide-y divide-[var(--card-border)] text-sm">
          {costs.map((c) => (
            <li key={c.id} className="flex items-center justify-between gap-2 py-1.5">
              <span>
                <span className="text-xs uppercase text-[var(--muted)]">{c.category}</span> {c.vendor}
                {c.description ? <span className="text-[var(--muted)]"> · {c.description}</span> : null}
                {c.incurred_on ? <span className="text-xs text-[var(--muted)]"> · {c.incurred_on}</span> : null}
              </span>
              <span className="flex items-center gap-2">
                <span className="tabular-nums">{usd2(Number(c.amount_cents))}</span>
                <form action={deleteJobCostAction.bind(null, jobId, Number(c.id))}>
                  <button className="text-xs text-[var(--muted)] hover:text-red-700" aria-label="Remove cost">✕</button>
                </form>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
