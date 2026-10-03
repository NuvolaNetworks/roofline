import Link from "next/link";
import { redirect } from "next/navigation";
import { getDb } from "@/lib/db";
import { currentUser, visibleUserIds } from "@/lib/auth";
import { commissionRows, commissionSettings, STATEMENT_DAYS, type CommissionRow } from "@/lib/commission";
import { payCommissionAction, saveCommissionSettingsAction, sendStatementsNowAction } from "@/lib/commission-actions";
import { usd2 } from "@/lib/fmt";

export const dynamic = "force-dynamic";

const input = "rounded-md border border-[var(--card-border)] bg-white px-2 py-1 text-sm";

function Breakdown({ r }: { r: CommissionRow }) {
  return (
    <span className="text-xs text-[var(--muted)]">
      collected {usd2(r.income_cents)} − costs {usd2(r.expenses_cents)} − overhead {usd2(r.overhead_cents)} = profit{" "}
      <span className={r.profit_cents < 0 ? "text-red-700" : ""}>{usd2(r.profit_cents)}</span>
    </span>
  );
}

export default async function Commissions({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; saved?: string; paid?: string; sent?: string }>;
}) {
  const q = await searchParams;
  const user = await currentUser();
  if (!user) redirect("/login");
  const db = getDb();
  const visible = user.role === "admin" ? null : await visibleUserIds(user);
  const settings = await commissionSettings(db, user.org_id);
  const ninetyDaysAgo = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 19).replace("T", " ");
  const due = await commissionRows(db, user.org_id, { visible, status: "due" });
  const paid = await commissionRows(db, user.org_id, { visible, status: "paid", paidSince: ninetyDaysAgo });
  const canPay = user.role !== "rep";

  const byRep = new Map<string, { jobs: number; total: number }>();
  for (const r of due) {
    const t = byRep.get(r.rep_name) ?? { jobs: 0, total: 0 };
    byRep.set(r.rep_name, { jobs: t.jobs + 1, total: t.total + r.commission_cents });
  }

  return (
    <div className="max-w-5xl space-y-6 p-6">
      <div>
        <h1 className="text-xl font-semibold">Commissions</h1>
        <p className="text-sm text-[var(--muted)]">
          Commission = (collected − job costs − {settings.overhead_pct}% of the contract for overhead) × {settings.rep_share_pct}%.
          A job is due once every invoice is paid (Ready for Commission). Reps are emailed their list on the{" "}
          {STATEMENT_DAYS.map((d) => (d === 1 ? "1st" : `${d}th`)).join(" and ")}
          {settings.statements_enabled ? "" : " (statements are turned off)"}.
        </p>
      </div>
      {q.error ? <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800">{q.error}</p> : null}
      {q.paid ? <p className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-800">Commission paid and job closed.</p> : null}
      {q.saved ? <p className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-800">Formula saved.</p> : null}
      {q.sent !== undefined ? (
        <p className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-800">
          {q.sent === "0" ? "No statements to send (no rep has jobs due, or the company isn't linked to AMOS email)." : `${q.sent} statement(s) queued.`}
        </p>
      ) : null}

      {byRep.size ? (
        <div className="flex flex-wrap gap-2">
          {[...byRep].map(([rep, t]) => (
            <div key={rep} className="rounded-lg border border-[var(--card-border)] bg-[var(--card)] px-3 py-2 text-sm">
              <div className="font-medium">{rep}</div>
              <div className="tabular-nums">{usd2(t.total)} <span className="text-xs text-[var(--muted)]">on {t.jobs} job{t.jobs === 1 ? "" : "s"}</span></div>
            </div>
          ))}
        </div>
      ) : null}

      <section className="rounded-xl border border-[var(--card-border)] bg-[var(--card)]">
        <div className="flex items-center justify-between border-b border-[var(--card-border)] px-4 py-3">
          <h2 className="font-semibold">Due</h2>
          {canPay ? (
            <form action={sendStatementsNowAction}>
              <button className="rounded-lg border border-[var(--card-border)] px-3 py-1 text-sm hover:bg-black/5">Email statements now</button>
            </form>
          ) : null}
        </div>
        {due.length === 0 ? (
          <p className="px-4 py-3 text-sm text-[var(--muted)]">Nothing awaiting payout.</p>
        ) : (
          <ul className="divide-y divide-[var(--card-border)]">
            {due.map((r) => (
              <li key={r.job_id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                <div>
                  <Link href={`/jobs/${r.job_id}`} className="font-medium hover:underline">{r.title}</Link>
                  <span className="text-sm text-[var(--muted)]"> · {r.rep_name}</span>
                  <div><Breakdown r={r} /></div>
                </div>
                <div className="flex items-center gap-3">
                  <span className="font-semibold tabular-nums">{usd2(r.commission_cents)}</span>
                  {canPay ? (
                    <form action={payCommissionAction.bind(null, r.job_id)}>
                      <button className="rounded-lg bg-[var(--accent)] px-3 py-1 text-sm text-white hover:bg-[var(--accent-light)]">Mark paid</button>
                    </form>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-xl border border-[var(--card-border)] bg-[var(--card)]">
        <h2 className="border-b border-[var(--card-border)] px-4 py-3 font-semibold">Paid (last 90 days)</h2>
        {paid.length === 0 ? (
          <p className="px-4 py-3 text-sm text-[var(--muted)]">No payouts yet.</p>
        ) : (
          <ul className="divide-y divide-[var(--card-border)] text-sm">
            {paid.map((r) => (
              <li key={r.job_id} className="flex justify-between gap-2 px-4 py-2">
                <span>
                  <Link href={`/jobs/${r.job_id}`} className="hover:underline">{r.title}</Link>
                  <span className="text-[var(--muted)]"> · {r.rep_name} · paid {String(r.paid_at ?? "").slice(0, 10)}</span>
                </span>
                <span className="tabular-nums">{usd2(r.paid_cents ?? 0)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {user.role === "admin" ? (
        <form action={saveCommissionSettingsAction} className="flex flex-wrap items-end gap-3 rounded-xl border border-[var(--card-border)] bg-[var(--card)] p-4">
          <label className="flex flex-col text-xs text-[var(--muted)]">Overhead (% of contract)
            <input name="overhead_pct" defaultValue={settings.overhead_pct} className={`${input} w-24 text-right`} />
          </label>
          <label className="flex flex-col text-xs text-[var(--muted)]">Rep share of profit (%)
            <input name="rep_share_pct" defaultValue={settings.rep_share_pct} className={`${input} w-24 text-right`} />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="statements_enabled" defaultChecked={settings.statements_enabled} /> Email statements on the 1st and 15th
          </label>
          <button className="rounded-lg border border-[var(--card-border)] px-3 py-1.5 text-sm hover:bg-black/5">Save formula</button>
        </form>
      ) : null}
    </div>
  );
}
