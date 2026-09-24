import Link from "next/link";
import { redirect } from "next/navigation";
import { getDb } from "@/lib/db";
import { currentUser } from "@/lib/auth";
import { tone } from "@/lib/fmt";

export const dynamic = "force-dynamic";

export default async function Measurements() {
  const user = await currentUser();
  if (!user) redirect("/login");
  const rows = await getDb().all(
    `SELECT m.*, j.title AS job, j.address FROM measurements m JOIN jobs j ON j.id = m.job_id
     WHERE m.org_id = ? ORDER BY m.id DESC`,
    user.org_id,
  );
  return (
    <div className="max-w-5xl p-6">
      <h1 className="mb-1 text-xl font-semibold">Measurements</h1>
      <p className="mb-4 text-sm text-[var(--muted)]">
        Every report pulled. Contract-grade reports (QuickMeasure, EagleView) carry per-edge linear footage;
        Solar-API estimates are rough and clearly labelled — they exist to price a lead instantly, never to sign one.
      </p>
      <div className="overflow-x-auto rounded-xl border border-[var(--card-border)] bg-[var(--card)]">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--card-border)] text-left text-[var(--muted)]">
              {["Job", "Provider", "Squares", "Pitch", "Ridge", "Hip", "Valley", "Eave", "Rake", "Status"].map((h) => (
                <th key={h} className="px-3 py-3 font-medium">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => (
              <tr key={String(m.id)} className="border-b border-[var(--card-border)] last:border-0">
                <td className="px-3 py-3">
                  <Link href={`/jobs/${m.job_id}`} className="text-[var(--accent-light)] hover:underline">
                    {String(m.job)}
                  </Link>
                  <div className="text-xs text-[var(--muted)]">{String(m.address)}</div>
                </td>
                <td className="px-3 py-3">{String(m.provider).replaceAll("_", " ")}</td>
                <td className="px-3 py-3 tabular-nums">{m.total_squares ? Number(m.total_squares) : "—"}</td>
                <td className="px-3 py-3 text-[var(--muted)]">{String(m.pitch ?? "—")}</td>
                {(["ridge_ft", "hip_ft", "valley_ft", "eave_ft", "rake_ft"] as const).map((k) => (
                  <td key={k} className="px-3 py-3 tabular-nums text-[var(--muted)]">
                    {m[k] ? `${Number(m[k])}'` : "—"}
                  </td>
                ))}
                <td className="px-3 py-3">
                  <span className={`rounded-full px-2 py-0.5 text-xs ${tone(m.status === "delivered" ? "Signed" : "Sent")}`}>
                    {String(m.status)}
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
