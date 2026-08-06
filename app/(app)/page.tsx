import Link from "next/link";
import { redirect } from "next/navigation";
import { getDb, STAGES } from "@/lib/db";
import { currentUser, visibleUserIds } from "@/lib/auth";

interface JobRow {
  id: number;
  title: string;
  address: string;
  trade: string;
  stage: string;
  value_cents: number;
  assignee: string;
  contact: string;
  updated_at: string;
}

export const dynamic = "force-dynamic";

export default async function JobsBoard() {
  const user = await currentUser();
  if (!user) redirect("/login");
  const ids = visibleUserIds(user);
  const rows = getDb()
    .prepare(
      `SELECT j.id, j.title, j.address, j.trade, j.stage, j.value_cents, j.updated_at,
              u.name AS assignee, c.name AS contact
       FROM jobs j
       LEFT JOIN users u ON u.id = j.assignee_id
       LEFT JOIN contacts c ON c.id = j.contact_id
       WHERE j.assignee_id IN (${ids.map(() => "?").join(",")})
       ORDER BY j.updated_at DESC`,
    )
    .all(...ids) as unknown as JobRow[];

  return (
    <div className="p-6">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold">Jobs</h1>
        <Link
          href="/leads/new"
          className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--accent-light)]"
        >
          + New lead
        </Link>
      </div>
      <div className="flex gap-4 overflow-x-auto pb-4">
        {STAGES.map((stage) => {
          const inStage = rows.filter((r) => r.stage === stage);
          const total = inStage.reduce((s, r) => s + r.value_cents, 0);
          return (
            <div key={stage} className="w-72 shrink-0">
              <div className="mb-2 flex items-baseline justify-between px-1">
                <span className="text-sm font-semibold">
                  {stage} <span className="text-[var(--muted)]">({inStage.length})</span>
                </span>
                <span className="text-xs text-[var(--muted)] tabular-nums">
                  ${(total / 100).toLocaleString()}
                </span>
              </div>
              <div className="space-y-2">
                {inStage.map((job) => (
                  <Link
                    key={job.id}
                    href={`/jobs/${job.id}`}
                    className="block rounded-xl border border-[var(--card-border)] bg-[var(--card)] p-3 shadow-sm hover:border-[var(--accent-light)]"
                  >
                    <div className="text-sm font-medium leading-snug">{job.title}</div>
                    <div className="mt-1 text-xs text-[var(--muted)]">{job.address}</div>
                    <div className="mt-2 flex items-center justify-between text-xs">
                      <span className="rounded-full bg-black/5 px-2 py-0.5">{job.trade}</span>
                      <span className="tabular-nums">
                        {job.value_cents > 0 ? `$${(job.value_cents / 100).toLocaleString()}` : "—"}
                      </span>
                    </div>
                    <div className="mt-1 text-[11px] text-[var(--muted)]">
                      {job.assignee} · {job.contact}
                    </div>
                  </Link>
                ))}
                {inStage.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-[var(--card-border)] p-3 text-center text-xs text-[var(--muted)]">
                    Empty
                  </div>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
