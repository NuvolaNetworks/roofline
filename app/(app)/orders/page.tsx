import Link from "next/link";
import { redirect } from "next/navigation";
import { getDb } from "@/lib/db";
import { currentUser } from "@/lib/auth";
import { advanceMaterialOrder } from "@/lib/actions";
import { usd, tone } from "@/lib/fmt";

export const dynamic = "force-dynamic";

export default async function Orders() {
  const user = await currentUser();
  if (!user) redirect("/login");
  const db = getDb();
  const materials = await db.all(
    "SELECT m.*, j.title AS job FROM material_orders m JOIN jobs j ON j.id = m.job_id WHERE m.org_id = ? ORDER BY m.id DESC",
    user.org_id,
  );
  const works = await db.all(
    "SELECT w.*, j.title AS job FROM work_orders w JOIN jobs j ON j.id = w.job_id WHERE w.org_id = ? ORDER BY w.id DESC",
    user.org_id,
  );
  return (
    <div className="max-w-4xl p-6">
      <h1 className="mb-1 text-xl font-semibold">Material &amp; Work Orders</h1>
      <p className="mb-4 text-sm text-[var(--muted)]">
        Material orders are built from proposal line items and park for approval — that call spends real money, so
        a human confirms it before it reaches SRS.
      </p>

      <h2 className="mb-2 font-semibold">Material orders</h2>
      <div className="mb-6 rounded-xl border border-[var(--card-border)] bg-[var(--card)]">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--card-border)] text-left text-[var(--muted)]">
              {["Supplier", "Job", "Deliver", "Total", "Status", ""].map((h, i) => (
                <th key={i} className="px-4 py-3 font-medium">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {materials.map((m) => {
              const advance = advanceMaterialOrder.bind(null, Number(m.id));
              return (
                <tr key={String(m.id)} className="border-b border-[var(--card-border)] last:border-0">
                  <td className="px-4 py-3">{String(m.supplier)}</td>
                  <td className="px-4 py-3 text-[var(--muted)]">
                    <Link href={`/jobs/${m.job_id}`} className="hover:underline">{String(m.job)}</Link>
                  </td>
                  <td className="px-4 py-3 text-[var(--muted)]">{String(m.deliver_on ?? "—")}</td>
                  <td className="px-4 py-3 tabular-nums">{usd(Number(m.total_cents))}</td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full px-2 py-0.5 text-xs ${tone(String(m.status))}`}>{String(m.status)}</span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    {m.status !== "Delivered" ? (
                      <form action={advance}>
                        <button className="rounded-lg border border-[var(--card-border)] px-3 py-1 text-xs hover:bg-black/5">
                          {m.status === "Pending approval" ? "Approve & order" : "Advance"}
                        </button>
                      </form>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <h2 className="mb-2 font-semibold">Work orders</h2>
      <div className="rounded-xl border border-[var(--card-border)] bg-[var(--card)]">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--card-border)] text-left text-[var(--muted)]">
              {["Crew", "Trade", "Job", "Scheduled", "Amount", "Status"].map((h) => (
                <th key={h} className="px-4 py-3 font-medium">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {works.map((w) => (
              <tr key={String(w.id)} className="border-b border-[var(--card-border)] last:border-0">
                <td className="px-4 py-3">{String(w.crew)}</td>
                <td className="px-4 py-3 text-[var(--muted)]">{String(w.trade)}</td>
                <td className="px-4 py-3 text-[var(--muted)]">
                  <Link href={`/jobs/${w.job_id}`} className="hover:underline">{String(w.job)}</Link>
                </td>
                <td className="px-4 py-3 text-[var(--muted)]">{String(w.scheduled_for ?? "—")}</td>
                <td className="px-4 py-3 tabular-nums">{usd(Number(w.amount_cents))}</td>
                <td className="px-4 py-3">
                  <span className={`rounded-full px-2 py-0.5 text-xs ${tone(String(w.status))}`}>{String(w.status)}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
