import Link from "next/link";
import { redirect } from "next/navigation";
import { getDb } from "@/lib/db";
import { currentUser } from "@/lib/auth";
import { markInvoicePaid } from "@/lib/actions";
import { usd2, tone } from "@/lib/fmt";

export const dynamic = "force-dynamic";

export default async function Invoices() {
  const user = await currentUser();
  if (!user) redirect("/login");
  const rows = await getDb().all(
    `SELECT i.*, j.title AS job, c.name AS contact FROM invoices i
     JOIN jobs j ON j.id = i.job_id LEFT JOIN contacts c ON c.id = j.contact_id
     WHERE i.org_id = ? ORDER BY i.id DESC`,
    user.org_id,
  );
  const outstanding = rows.filter((r) => r.status !== "Paid").reduce((s, r) => s + Number(r.amount_cents), 0);
  const paid = rows.filter((r) => r.status === "Paid").reduce((s, r) => s + Number(r.amount_cents), 0);
  return (
    <div className="max-w-4xl p-6">
      <h1 className="mb-1 text-xl font-semibold">Invoices</h1>
      <p className="mb-4 text-sm text-[var(--muted)]">
        {usd2(outstanding)} outstanding · {usd2(paid)} collected. Payment links are issued through the AMOS
        merchant connection; QuickBooks sync mirrors each invoice.
      </p>
      <div className="rounded-xl border border-[var(--card-border)] bg-[var(--card)]">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--card-border)] text-left text-[var(--muted)]">
              {["Invoice", "Job", "Customer", "Due", "Amount", "Status", ""].map((h, i) => (
                <th key={i} className="px-4 py-3 font-medium">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((i) => {
              const pay = markInvoicePaid.bind(null, Number(i.id));
              return (
                <tr key={String(i.id)} className="border-b border-[var(--card-border)] last:border-0">
                  <td className="px-4 py-3">{String(i.kind)} #{String(i.id)}</td>
                  <td className="px-4 py-3 text-[var(--muted)]">
                    <Link href={`/jobs/${i.job_id}`} className="hover:underline">{String(i.job)}</Link>
                  </td>
                  <td className="px-4 py-3">{String(i.contact ?? "")}</td>
                  <td className="px-4 py-3 text-[var(--muted)]">{String(i.due_on ?? "—")}</td>
                  <td className="px-4 py-3 tabular-nums">{usd2(Number(i.amount_cents))}</td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full px-2 py-0.5 text-xs ${tone(String(i.status))}`}>{String(i.status)}</span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    {i.status !== "Paid" ? (
                      <form action={pay}>
                        <button className="rounded-lg border border-[var(--card-border)] px-3 py-1 text-xs hover:bg-black/5">
                          Mark paid
                        </button>
                      </form>
                    ) : (
                      <span className="text-xs text-[var(--muted)]">{String(i.paid_at ?? "").slice(0, 10)}</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
