import { redirect } from "next/navigation";
import { getDb } from "@/lib/db";
import { currentUser, visibleUserIds } from "@/lib/auth";

export const dynamic = "force-dynamic";

const TRADE_COLORS: Record<string, string> = {
  Roofing: "bg-blue-100 text-blue-800",
  Concrete: "bg-stone-200 text-stone-800",
  Carpentry: "bg-amber-100 text-amber-800",
  Remodel: "bg-purple-100 text-purple-800",
  Gutters: "bg-teal-100 text-teal-800",
};

export default async function CalendarPage() {
  const user = await currentUser();
  if (!user) redirect("/login");
  const ids = visibleUserIds(user);
  const jobs = getDb()
    .prepare(
      `SELECT j.id, j.title, j.trade, j.scheduled_for, u.name AS assignee
       FROM jobs j JOIN users u ON u.id = j.assignee_id
       WHERE j.scheduled_for IS NOT NULL AND j.assignee_id IN (${ids.map(() => "?").join(",")})
       ORDER BY j.scheduled_for`,
    )
    .all(...ids) as Array<Record<string, unknown>>;

  return (
    <div className="p-6 max-w-2xl">
      <h1 className="mb-1 text-xl font-semibold">Production calendar</h1>
      <p className="mb-4 text-sm text-[var(--muted)]">
        Color-coded by trade. Google Calendar two-way sync is the planned
        integration; this is the production source of truth.
      </p>
      <div className="space-y-2">
        {jobs.map((j) => (
          <a
            key={String(j.id)}
            href={`/jobs/${j.id}`}
            className="flex items-center justify-between rounded-xl border border-[var(--card-border)] bg-[var(--card)] p-3 text-sm hover:border-[var(--accent-light)]"
          >
            <span>
              <span className="mr-3 font-mono text-xs text-[var(--muted)]">
                {String(j.scheduled_for)}
              </span>
              {String(j.title)}
            </span>
            <span className="flex items-center gap-2">
              <span className={`rounded-full px-2 py-0.5 text-xs ${TRADE_COLORS[String(j.trade)] ?? "bg-black/5"}`}>
                {String(j.trade)}
              </span>
              <span className="text-xs text-[var(--muted)]">{String(j.assignee)}</span>
            </span>
          </a>
        ))}
        {jobs.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">Nothing scheduled.</p>
        ) : null}
      </div>
    </div>
  );
}
