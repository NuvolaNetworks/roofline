import Link from "next/link";
import { redirect } from "next/navigation";
import { getDb } from "@/lib/db";
import { currentUser } from "@/lib/auth";
import { signDocument } from "@/lib/actions";
import { tone } from "@/lib/fmt";

export const dynamic = "force-dynamic";

export default async function Documents() {
  const user = await currentUser();
  if (!user) redirect("/login");
  const db = getDb();
  const docs = await db.all(
    `SELECT d.*, j.title AS job, t.name AS template FROM documents d
     JOIN jobs j ON j.id = d.job_id LEFT JOIN templates t ON t.id = d.template_id
     WHERE d.org_id = ? ORDER BY d.id DESC`,
    user.org_id,
  );
  const templates = await db.all(
    "SELECT * FROM templates WHERE org_id = ? ORDER BY kind",
    user.org_id,
  );
  return (
    <div className="max-w-4xl p-6">
      <h1 className="mb-1 text-xl font-semibold">PDF Signer &amp; File Manager</h1>
      <p className="mb-4 text-sm text-[var(--muted)]">
        Templates auto-fill from the job file; signed documents land back on the job.
      </p>
      <div className="mb-6 rounded-xl border border-[var(--card-border)] bg-[var(--card)]">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--card-border)] text-left text-[var(--muted)]">
              {["Document", "Job", "Signer", "Status", ""].map((h, i) => (
                <th key={i} className="px-4 py-3 font-medium">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {docs.map((d) => {
              const sign = signDocument.bind(null, Number(d.id));
              return (
                <tr key={String(d.id)} className="border-b border-[var(--card-border)] last:border-0">
                  <td className="px-4 py-3">{String(d.name)}</td>
                  <td className="px-4 py-3 text-[var(--muted)]">
                    <Link href={`/jobs/${d.job_id}`} className="hover:underline">{String(d.job)}</Link>
                  </td>
                  <td className="px-4 py-3 text-[var(--muted)]">{String(d.signer ?? "—")}</td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full px-2 py-0.5 text-xs ${tone(String(d.status))}`}>{String(d.status)}</span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    {d.status !== "Signed" ? (
                      <form action={sign}>
                        <button className="rounded-lg border border-[var(--card-border)] px-3 py-1 text-xs hover:bg-black/5">
                          Record signature
                        </button>
                      </form>
                    ) : (
                      <span className="text-xs text-[var(--muted)]">{String(d.signed_at ?? "").slice(0, 10)}</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <h2 className="mb-2 font-semibold">Templates</h2>
      <div className="grid gap-2 sm:grid-cols-2">
        {templates.map((t) => (
          <div key={String(t.id)} className="rounded-xl border border-[var(--card-border)] bg-[var(--card)] p-3">
            <div className="text-sm font-medium">{String(t.name)}</div>
            <div className="text-xs text-[var(--muted)]">{String(t.kind)} · fills: {String(t.fields)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
