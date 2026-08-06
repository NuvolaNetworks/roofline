import Link from "next/link";
import { redirect } from "next/navigation";
import { getDb } from "@/lib/db";
import { currentUser, visibleUserIds } from "@/lib/auth";
import { daysSince } from "@/lib/fmt";

export const dynamic = "force-dynamic";

const KIND_TONE: Record<string, string> = {
  email: "bg-amber-100 text-amber-800",
  sms: "bg-teal-100 text-teal-800",
  stage: "bg-blue-100 text-blue-800",
};

export default async function Communications({
  searchParams,
}: {
  searchParams: Promise<{ dir?: string }>;
}) {
  const user = await currentUser();
  if (!user) redirect("/login");
  const { dir = "all" } = await searchParams;
  const ids = visibleUserIds(user);
  const ph = ids.map(() => "?").join(",");
  const rows = getDb()
    .prepare(
      `SELECT e.*, j.title AS job, c.name AS contact FROM job_events e
       JOIN jobs j ON j.id = e.job_id LEFT JOIN contacts c ON c.id = j.contact_id
       WHERE j.assignee_id IN (${ph}) AND e.kind IN ('email','sms','note')
       ORDER BY e.id DESC LIMIT 100`,
    )
    .all(...ids) as Array<Record<string, unknown>>;
  const shown = dir === "all" ? rows : rows.filter((r) => String(r.direction) === dir);

  return (
    <div className="max-w-3xl p-6">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold">Communications</h1>
        <div className="flex overflow-hidden rounded-lg border border-[var(--card-border)] text-sm">
          {["all", "inbound", "outbound", "internal"].map((d) => (
            <Link
              key={d}
              href={`/communications?dir=${d}`}
              className={`px-3 py-1.5 capitalize ${d === dir ? "bg-[var(--accent)] text-white" : "hover:bg-black/5"}`}
            >
              {d}
            </Link>
          ))}
        </div>
      </div>
      <p className="mb-4 text-sm text-[var(--muted)]">
        Every thread across your jobs. Sends route through the AMOS email engine and Twilio connection, so each
        outbound message is governed and receipted.
      </p>
      <div className="rounded-xl border border-[var(--card-border)] bg-[var(--card)]">
        {shown.map((e) => (
          <div key={String(e.id)} className="border-b border-[var(--card-border)] p-4 last:border-0">
            <div className="mb-1 flex items-center gap-2">
              <span className={`rounded-full px-2 py-0.5 text-[10px] ${KIND_TONE[String(e.kind)] ?? "bg-black/5 text-[var(--muted)]"}`}>
                {String(e.kind)}
              </span>
              <span className="text-[10px] uppercase tracking-wide text-[var(--muted)]">{String(e.direction)}</span>
              <Link href={`/jobs/${e.job_id}`} className="text-sm text-[var(--accent-light)] hover:underline">
                {String(e.job)}
              </Link>
              <span className="ml-auto text-xs text-[var(--muted)]">{daysSince(String(e.created_at))}d ago</span>
            </div>
            <div className="text-sm">{String(e.body)}</div>
            <div className="mt-0.5 text-xs text-[var(--muted)]">
              {String(e.actor)}{e.contact ? ` · ${String(e.contact)}` : ""}
            </div>
          </div>
        ))}
        {shown.length === 0 ? <div className="p-6 text-center text-sm text-[var(--muted)]">Nothing here.</div> : null}
      </div>
    </div>
  );
}
