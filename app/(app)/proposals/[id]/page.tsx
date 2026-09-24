import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getDb } from "@/lib/db";
import { currentUser } from "@/lib/auth";
import { setProposalStatus } from "@/lib/actions";
import { usd, usd2, tone } from "@/lib/fmt";

export const dynamic = "force-dynamic";

export default async function Proposal({ params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) redirect("/login");
  const { id } = await params;
  const db = getDb();
  const p = await db.get(
    `SELECT p.*, j.title AS job, j.address, c.name AS contact
     FROM proposals p JOIN jobs j ON j.id = p.job_id
     LEFT JOIN contacts c ON c.id = j.contact_id WHERE p.id = ? AND p.org_id = ?`,
    Number(id), user.org_id,
  );
  if (!p) notFound();
  const lines = await db.all(
    "SELECT * FROM proposal_lines WHERE proposal_id = ? AND org_id = ? ORDER BY id",
    Number(id), user.org_id,
  );
  const total = lines.reduce((s, l) => s + Number(l.qty) * Number(l.unit_price_cents), 0);
  const cost = lines.reduce((s, l) => s + Number(l.qty) * Number(l.unit_cost_cents), 0);
  const status = String(p.status);
  const next = status === "Draft" ? "Sent" : status === "Sent" ? "Viewed" : status === "Viewed" ? "Signed" : null;
  const advance = next ? setProposalStatus.bind(null, Number(id), next) : null;

  return (
    <div className="max-w-3xl p-6">
      <div className="mb-4 flex items-start justify-between">
        <div>
          <h1 className="text-xl font-semibold">{String(p.name)}</h1>
          <p className="text-sm text-[var(--muted)]">
            <Link href={`/jobs/${p.job_id}`} className="text-[var(--accent-light)] hover:underline">
              {String(p.job)}
            </Link>{" "}
            · {String(p.contact ?? "")} · {String(p.address ?? "")}
          </p>
        </div>
        <div className="text-right">
          <span className={`rounded-full px-2 py-0.5 text-xs ${tone(status)}`}>{status}</span>
          {advance ? (
            <form action={advance} className="mt-2">
              <button className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-sm text-white hover:bg-[var(--accent-light)]">
                Mark {next}
              </button>
            </form>
          ) : null}
        </div>
      </div>

      <div className="rounded-xl border border-[var(--card-border)] bg-[var(--card)]">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--card-border)] text-left text-[var(--muted)]">
              <th className="px-4 py-3 font-medium">SKU</th>
              <th className="px-4 py-3 font-medium">Item</th>
              <th className="px-4 py-3 font-medium text-right">Qty</th>
              <th className="px-4 py-3 font-medium text-right">Unit</th>
              <th className="px-4 py-3 font-medium text-right">Total</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={String(l.id)} className="border-b border-[var(--card-border)] last:border-0">
                <td className="px-4 py-2 font-mono text-xs">{String(l.sku)}</td>
                <td className="px-4 py-2">{String(l.name)}</td>
                <td className="px-4 py-2 text-right tabular-nums">
                  {Number(l.qty)} <span className="text-xs text-[var(--muted)]">{String(l.unit)}</span>
                </td>
                <td className="px-4 py-2 text-right tabular-nums">{usd2(Number(l.unit_price_cents))}</td>
                <td className="px-4 py-2 text-right tabular-nums">
                  {usd2(Math.round(Number(l.qty) * Number(l.unit_price_cents)))}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-[var(--card-border)] font-semibold">
              <td className="px-4 py-3" colSpan={4}>Total</td>
              <td className="px-4 py-3 text-right tabular-nums">{usd2(total)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="mt-3 text-xs text-[var(--muted)]">
        Cost {usd(cost)} · margin {usd(total - cost)}
        {total > 0 ? ` (${Math.round(((total - cost) / total) * 100)}%)` : ""} · material lines order straight
        from here through the SRS connection.
      </p>
    </div>
  );
}
