import Link from "next/link";
import { redirect } from "next/navigation";
import { getDb, STAGES, WORKFLOWS } from "@/lib/db";
import { currentUser, visibleUserIds } from "@/lib/auth";
import { usd, daysSince } from "@/lib/fmt";

export const dynamic = "force-dynamic";

interface JobRow {
  id: number;
  title: string;
  address: string;
  trade: string;
  workflow: string;
  stage: string;
  value_cents: number;
  stage_since: string;
  updated_at: string;
  assignee: string;
  contact: string;
  proposal_status: string | null;
  invoice_status: string | null;
}

export default async function JobsBoard({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; workflow?: string; view?: string }>;
}) {
  const user = await currentUser();
  if (!user) redirect("/login");
  const { q = "", workflow = "All workflows", view = "board" } = await searchParams;
  const ids = await visibleUserIds(user);
  const ph = ids.map(() => "?").join(",");

  const rows = await getDb().all<JobRow>(
    `SELECT j.id, j.title, j.address, j.trade, j.workflow, j.stage, j.value_cents,
            j.stage_since, j.updated_at,
            u.name AS assignee, c.name AS contact,
            (SELECT status FROM proposals p WHERE p.job_id = j.id ORDER BY p.id DESC LIMIT 1) AS proposal_status,
            (SELECT status FROM invoices i WHERE i.job_id = j.id ORDER BY i.id DESC LIMIT 1) AS invoice_status
     FROM jobs j LEFT JOIN users u ON u.id = j.assignee_id
     LEFT JOIN contacts c ON c.id = j.contact_id
     WHERE j.assignee_id IN (${ph}) AND j.org_id = ? ORDER BY j.updated_at DESC`,
    ...ids, user.org_id,
  );

  const needle = q.trim().toLowerCase();
  const jobs = rows.filter(
    (r) =>
      (workflow === "All workflows" || r.workflow === workflow) &&
      (!needle ||
        `${r.title} ${r.address} ${r.contact} ${r.assignee} ${r.trade}`.toLowerCase().includes(needle)),
  );

  const qs = (over: Record<string, string>) => {
    const p = new URLSearchParams({ q, workflow, view, ...over });
    return `/jobs?${p.toString()}`;
  };

  return (
    <div className="p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Jobs</h1>
        <div className="flex flex-wrap items-center gap-2">
          <form className="flex items-center gap-2">
            <input type="hidden" name="workflow" value={workflow} />
            <input type="hidden" name="view" value={view} />
            <input
              name="q"
              defaultValue={q}
              placeholder="Search jobs, addresses, customers…"
              className="w-64 rounded-lg border border-[var(--card-border)] px-3 py-1.5 text-sm"
            />
          </form>
          <div className="flex overflow-hidden rounded-lg border border-[var(--card-border)] text-sm">
            {["All workflows", ...WORKFLOWS].map((w) => (
              <Link
                key={w}
                href={qs({ workflow: w })}
                className={`px-3 py-1.5 ${w === workflow ? "bg-[var(--accent)] text-white" : "hover:bg-black/5"}`}
              >
                {w}
              </Link>
            ))}
          </div>
          <div className="flex overflow-hidden rounded-lg border border-[var(--card-border)] text-sm">
            {["board", "list"].map((v) => (
              <Link
                key={v}
                href={qs({ view: v })}
                className={`px-3 py-1.5 capitalize ${v === view ? "bg-[var(--accent)] text-white" : "hover:bg-black/5"}`}
              >
                {v}
              </Link>
            ))}
          </div>
          <Link
            href="/leads/new"
            className="rounded-lg bg-[var(--accent)] px-4 py-1.5 text-sm font-medium text-white hover:bg-[var(--accent-light)]"
          >
            + New
          </Link>
        </div>
      </div>

      {view === "list" ? <ListView jobs={jobs} /> : <BoardView jobs={jobs} />}
    </div>
  );
}

function Badges({ job }: { job: JobRow }) {
  const age = daysSince(job.stage_since);
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
      <span className="rounded-full bg-black/5 px-2 py-0.5">{job.trade}</span>
      {job.proposal_status ? (
        <span
          className={`rounded-full px-2 py-0.5 ${
            job.proposal_status === "Signed"
              ? "bg-emerald-100 text-emerald-800"
              : job.proposal_status === "Sent"
                ? "bg-blue-100 text-blue-800"
                : "bg-black/5 text-[var(--muted)]"
          }`}
        >
          {job.proposal_status}
        </span>
      ) : null}
      {job.invoice_status === "Paid" ? (
        <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-emerald-800">Paid</span>
      ) : null}
      <span className={age >= 14 ? "text-red-600" : "text-[var(--muted)]"}>
        {age === 0 ? "today" : `${age}d in stage`}
      </span>
    </div>
  );
}

function BoardView({ jobs }: { jobs: JobRow[] }) {
  return (
    <div className="flex gap-4 overflow-x-auto pb-4">
      {STAGES.map((stage) => {
        const inStage = jobs.filter((j) => j.stage === stage);
        const total = inStage.reduce((s, j) => s + j.value_cents, 0);
        return (
          <div key={stage} className="w-72 shrink-0">
            <div className="mb-2 flex items-baseline justify-between px-1">
              <span className="text-sm font-semibold">
                {stage} <span className="text-[var(--muted)]">({inStage.length})</span>
              </span>
              <span className="text-xs tabular-nums text-[var(--muted)]">{usd(total)}</span>
            </div>
            <div className="space-y-2">
              {inStage.map((job) => (
                <Link
                  key={job.id}
                  href={`/jobs/${job.id}`}
                  className="block rounded-xl border border-[var(--card-border)] bg-[var(--card)] p-3 shadow-sm hover:border-[var(--accent-light)]"
                >
                  <div className="text-sm font-medium leading-snug">{job.title}</div>
                  <div className="mt-0.5 text-xs text-[var(--muted)]">{job.address}</div>
                  <div className="mt-1 flex items-center justify-between text-xs">
                    <span className="text-[var(--muted)]">{job.contact}</span>
                    <span className="tabular-nums">{job.value_cents > 0 ? usd(job.value_cents) : "—"}</span>
                  </div>
                  <Badges job={job} />
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
  );
}

function ListView({ jobs }: { jobs: JobRow[] }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-[var(--card-border)] bg-[var(--card)]">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-[var(--card-border)] text-left text-[var(--muted)]">
            {["Job", "Customer", "Stage", "Age", "Workflow", "Rep", "Value"].map((h) => (
              <th key={h} className="px-4 py-3 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {jobs.map((j) => {
            const age = daysSince(j.stage_since);
            return (
              <tr key={j.id} className="border-b border-[var(--card-border)] last:border-0 hover:bg-black/5">
                <td className="px-4 py-3">
                  <Link href={`/jobs/${j.id}`} className="text-[var(--accent-light)] hover:underline">
                    {j.title}
                  </Link>
                  <div className="text-xs text-[var(--muted)]">{j.address}</div>
                </td>
                <td className="px-4 py-3">{j.contact}</td>
                <td className="px-4 py-3">{j.stage}</td>
                <td className={`px-4 py-3 tabular-nums ${age >= 14 ? "text-red-600" : "text-[var(--muted)]"}`}>
                  {age}d
                </td>
                <td className="px-4 py-3 text-[var(--muted)]">{j.workflow}</td>
                <td className="px-4 py-3 text-[var(--muted)]">{j.assignee}</td>
                <td className="px-4 py-3 text-right tabular-nums">
                  {j.value_cents > 0 ? usd(j.value_cents) : "—"}
                </td>
              </tr>
            );
          })}
          {jobs.length === 0 ? (
            <tr>
              <td colSpan={7} className="px-4 py-6 text-center text-[var(--muted)]">
                No jobs match.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}
