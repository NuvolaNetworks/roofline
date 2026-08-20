import Link from "next/link";
import { redirect } from "next/navigation";
import { getDb } from "@/lib/db";
import { currentUser } from "@/lib/auth";
import { usd2 } from "@/lib/fmt";

export const dynamic = "force-dynamic";

export default async function Payments() {
  const user = await currentUser();
  if (!user) redirect("/login");
  const rows = await getDb().all(
    `SELECT p.*, i.kind, i.job_id, j.title AS job, c.name AS contact FROM payments p
     JOIN invoices i ON i.id = p.invoice_id JOIN jobs j ON j.id = i.job_id
     LEFT JOIN contacts c ON c.id = j.contact_id
     WHERE p.org_id = ? ORDER BY p.received_at DESC`,
    user.org_id,
  );
  const total = rows.reduce((s, r) => s + Number(r.amount_cents), 0);
  return (
    <div className="max-w-4xl p-6">
      <h1 className="mb-1 text-xl font-semibold">Payments</h1>
      <p className="mb-4 text-sm text-[var(--muted)]">{usd2(total)} received across {rows.length} payments.</p>
      <div className="rounded-xl border border-[var(--card-border)] bg-[var(--card)]">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--card-border)] text-left text-[var(--muted)]">
              {["Received", "Job", "Customer", "For", "Method", "Reference", "Amount"].map((h) => (
                <th key={h} className="px-4 py-3 font-medium">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={String(p.id)} className="border-b border-[var(--card-border)] last:border-0">
                <td className="px-4 py-3 text-[var(--muted)]">{String(p.received_at).slice(0, 16)}</td>
                <td className="px-4 py-3">
                  <Link href={`/jobs/${p.job_id}`} className="text-[var(--accent-light)] hover:underline">
                    {String(p.job)}
                  </Link>
                </td>
                <td className="px-4 py-3">{String(p.contact ?? "")}</td>
                <td className="px-4 py-3 text-[var(--muted)]">{String(p.kind)}</td>
                <td className="px-4 py-3">{String(p.method)}</td>
                <td className="px-4 py-3 font-mono text-xs text-[var(--muted)]">{String(p.reference ?? "")}</td>
                <td className="px-4 py-3 text-right tabular-nums">{usd2(Number(p.amount_cents))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
