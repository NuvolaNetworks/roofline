import Link from "next/link";
import { redirect } from "next/navigation";
import { getDb } from "@/lib/db";
import { currentUser } from "@/lib/auth";
import { usd2, tone } from "@/lib/fmt";

export const dynamic = "force-dynamic";

export default async function Invoices() {
  const user = await currentUser();
  if (!user) redirect("/login");
  const rows = await getDb().all<Record<string, unknown>>(
    `SELECT i.*, j.title AS job, c.name AS contact FROM invoices i
     JOIN jobs j ON j.id = i.job_id LEFT JOIN contacts c ON c.id = j.contact_id
     WHERE i.org_id = ? ORDER BY i.id DESC`,
    user.org_id,
  );
  const live = rows.filter((r) => r.status !== "Void");
  const outstanding = live.reduce((s, r) => s + Math.max(0, Number(r.amount_cents) - Number(r.amount_paid_cents ?? 0)), 0);
  const collected = live.reduce((s, r) => s + Number(r.amount_paid_cents ?? 0), 0);
  return (
    <div className="max-w-5xl p-6">
      <h1 className="mb-1 text-xl font-semibold">Invoices</h1>
      <p className="mb-4 text-sm text-[var(--muted)]">
        {usd2(outstanding)} outstanding · {usd2(collected)} collected. Create invoices from a signed proposal on its job —
        bill a percent (50% deposit) or the remaining balance, send it to the homeowner, and record payments as they come in.
      </p>
      <div className="rounded-xl border border-[var(--card-border)] bg-[var(--card)]">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--card-border)] text-left text-[var(--muted)]">
              {["Invoice", "Job", "Customer", "Due", "Amount", "Paid", "Status"].map((h) => (
                <th key={h} className="px-4 py-3 font-medium">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((i) => (
              <tr key={String(i.id)} className="border-b border-[var(--card-border)] last:border-0">
                <td className="px-4 py-3">
                  {i.proposal_id ? (
                    <a href={`/invoices/${i.id}/pdf`} target="_blank" rel="noreferrer" className="text-[var(--accent-light)] hover:underline">
                      {String(i.number ?? `#${i.id}`)}
                    </a>
                  ) : (
                    String(i.number ?? `${i.kind} #${i.id}`)
                  )}
                  <div className="text-xs text-[var(--muted)]">{String(i.title ?? i.kind)}</div>
                </td>
                <td className="px-4 py-3 text-[var(--muted)]">
                  <Link href={`/jobs/${i.job_id}`} className="hover:underline">{String(i.job)}</Link>
                </td>
                <td className="px-4 py-3">{String(i.contact ?? "")}</td>
                <td className="px-4 py-3 text-[var(--muted)]">{String(i.due_on ?? "—")}</td>
                <td className="px-4 py-3 tabular-nums">{usd2(Number(i.amount_cents))}</td>
                <td className="px-4 py-3 tabular-nums text-[var(--muted)]">{usd2(Number(i.amount_paid_cents ?? 0))}</td>
                <td className="px-4 py-3">
                  <span className={`rounded-full px-2 py-0.5 text-xs ${tone(String(i.status) === "Partially paid" ? "Viewed" : String(i.status) === "Void" ? "Declined" : String(i.status))}`}>
                    {String(i.status)}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
