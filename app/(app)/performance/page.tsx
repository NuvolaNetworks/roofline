import { redirect } from "next/navigation";
import { getDb } from "@/lib/db";
import { currentUser, visibleUserIds } from "@/lib/auth";
import { commissionRows } from "@/lib/commission";
import { usd2 } from "@/lib/fmt";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function Performance() {
  const user = await currentUser();
  if (!user) redirect("/login");
  const ids = await visibleUserIds(user);
  const ph = ids.map(() => "?").join(",");
  const db = getDb();
  const rows = await db.all(
    `SELECT u.name,
            COUNT(*) AS jobs,
            SUM(CASE WHEN j.stage IN ('Approved','Scheduled','Completed/Invoiced','Ready for Commission','Closed') THEN 1 ELSE 0 END) AS won,
            COALESCE(SUM(CASE WHEN j.stage != 'Lead' THEN j.value_cents ELSE 0 END), 0) AS pipeline_cents
     FROM jobs j JOIN users u ON u.id = j.assignee_id
     WHERE j.assignee_id IN (${ph}) AND j.org_id = ?
     GROUP BY u.name ORDER BY pipeline_cents DESC`,
    ...ids, user.org_id,
  );
  const commission = await commissionRows(db, user.org_id, { visible: ids, status: "due" });

  return (
    <div className="p-6 max-w-3xl">
      <h1 className="mb-4 text-xl font-semibold">Performance</h1>
      <div className="mb-6 rounded-xl border border-[var(--card-border)] bg-[var(--card)]">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--card-border)] text-left text-[var(--muted)]">
              <th className="px-4 py-3 font-medium">Rep</th>
              <th className="px-4 py-3 font-medium text-right">Jobs</th>
              <th className="px-4 py-3 font-medium text-right">Won</th>
              <th className="px-4 py-3 font-medium text-right">Pipeline value</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={String(r.name)} className="border-b border-[var(--card-border)] last:border-0">
                <td className="px-4 py-3">{String(r.name)}</td>
                <td className="px-4 py-3 text-right tabular-nums">{String(r.jobs)}</td>
                <td className="px-4 py-3 text-right tabular-nums">{String(r.won)}</td>
                <td className="px-4 py-3 text-right tabular-nums">
                  ${(Number(r.pipeline_cents) / 100).toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 className="mb-2 font-semibold">
        Ready for commission <Link href="/commissions" className="text-sm font-normal text-[var(--accent)] hover:underline">all commissions →</Link>
      </h2>
      <div className="rounded-xl border border-[var(--card-border)] bg-[var(--card)] p-4">
        {commission.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">Nothing awaiting payout.</p>
        ) : (
          commission.map((c) => (
            <div key={c.job_id} className="flex justify-between border-b border-[var(--card-border)] py-2 text-sm last:border-0">
              <span>
                <Link href={`/jobs/${c.job_id}`} className="hover:underline">{c.title}</Link>{" "}
                <span className="text-[var(--muted)]">— {c.rep_name}</span>
              </span>
              <span className="tabular-nums">
                {usd2(c.commission_cents)} commission
                <span className="ml-2 text-xs text-[var(--muted)]">(profit {usd2(c.profit_cents)})</span>
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
