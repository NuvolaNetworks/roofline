import Link from "next/link";
import { redirect } from "next/navigation";
import { getDb } from "@/lib/db";
import { currentUser } from "@/lib/auth";
import { usd, tone } from "@/lib/fmt";
import { newProposalForJob } from "@/lib/proposal-actions";

export const dynamic = "force-dynamic";

export default async function Proposals({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const user = await currentUser();
  if (!user) redirect("/login");
  const { error } = await searchParams;
  const jobs = await getDb().all<{ id: number; title: string; contact: string | null }>(
    `SELECT j.id, j.title, c.name AS contact FROM jobs j LEFT JOIN contacts c ON c.id = j.contact_id
     WHERE j.org_id = ? AND j.stage NOT IN ('Closed') ORDER BY j.updated_at DESC LIMIT 200`,
    user.org_id,
  );
  const rows = await getDb().all(
    `SELECT p.*, j.title AS job, c.name AS contact
     FROM proposals p JOIN jobs j ON j.id = p.job_id
     LEFT JOIN contacts c ON c.id = j.contact_id
     WHERE p.org_id = ? ORDER BY p.id DESC`,
    user.org_id,
  );
  const templates = await getDb().all(
    "SELECT * FROM templates WHERE org_id = ? AND kind = 'proposal'",
    user.org_id,
  );
  return (
    <div className="max-w-4xl p-6">
      <h1 className="mb-1 text-xl font-semibold">Proposals</h1>
      <p className="mb-4 text-sm text-[var(--muted)]">
        Built from the measurement report and priced from the catalog. Sending, viewing and signing move the job.
      </p>
      {error ? <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-800">{error}</div> : null}
      <form action={newProposalForJob} className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-[var(--card-border)] bg-[var(--card)] p-3">
        <span className="text-sm font-medium">New proposal for</span>
        <select name="job_id" required defaultValue="" className="min-w-64 rounded-md border border-[var(--card-border)] bg-white px-2 py-1.5 text-sm">
          <option value="" disabled>Choose a job…</option>
          {jobs.map((j) => (
            <option key={j.id} value={j.id}>{j.title}{j.contact ? ` — ${j.contact}` : ""}</option>
          ))}
        </select>
        <button name="mode" value="measurement" className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-sm text-white hover:bg-[var(--accent-light)]">
          From measurement
        </button>
        <button name="mode" value="blank" className="rounded-lg border border-[var(--card-border)] px-3 py-1.5 text-sm hover:bg-black/5">
          Blank
        </button>
      </form>
      <div className="mb-6 rounded-xl border border-[var(--card-border)] bg-[var(--card)]">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--card-border)] text-left text-[var(--muted)]">
              {["Proposal", "Job", "Customer", "Value", "Margin", "Status"].map((h) => (
                <th key={h} className="px-4 py-3 font-medium">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => {
              const total = Number(p.total_cents);
              const margin = total - Number(p.cost_cents);
              return (
                <tr key={String(p.id)} className="border-b border-[var(--card-border)] last:border-0 hover:bg-black/5">
                  <td className="px-4 py-3">
                    <Link href={`/proposals/${p.id}`} className="text-[var(--accent-light)] hover:underline">
                      {String(p.name)}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-[var(--muted)]">
                    <Link href={`/jobs/${p.job_id}`} className="hover:underline">{String(p.job)}</Link>
                  </td>
                  <td className="px-4 py-3">{String(p.contact ?? "")}</td>
                  <td className="px-4 py-3 tabular-nums">{usd(total)}</td>
                  <td className="px-4 py-3 tabular-nums text-[var(--muted)]">
                    {total > 0 ? `${usd(margin)} (${Math.round((margin / total) * 100)}%)` : "—"}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full px-2 py-0.5 text-xs ${tone(String(p.status))}`}>{String(p.status)}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <h2 className="mb-2 flex items-center justify-between font-semibold">
        Templates
        <Link href="/templates" className="text-xs font-normal text-[var(--accent-light)] hover:underline">Manage templates</Link>
      </h2>
      <div className="space-y-2">
        {templates.map((t) => (
          <div key={String(t.id)} className="rounded-xl border border-[var(--card-border)] bg-[var(--card)] p-3 text-sm">
            <Link href={`/templates/${t.id}`} className="font-medium hover:underline">{String(t.name)}</Link>
            <div className="text-xs text-[var(--muted)]">cover · estimate · summary &amp; signatures · spec sheets · terms</div>
          </div>
        ))}
      </div>
    </div>
  );
}
