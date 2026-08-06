import Link from "next/link";
import { redirect } from "next/navigation";
import { getDb, STAGES } from "@/lib/db";
import { currentUser, visibleUserIds } from "@/lib/auth";
import { toggleTask } from "@/lib/actions";
import { usd, daysSince, tone } from "@/lib/fmt";

export const dynamic = "force-dynamic";

export default async function Home() {
  const user = await currentUser();
  if (!user) redirect("/login");
  const ids = visibleUserIds(user);
  const ph = ids.map(() => "?").join(",");
  const db = getDb();

  const tasks = db
    .prepare(
      `SELECT t.id, t.title, t.due_on, t.done, t.job_id, j.title AS job
       FROM tasks t LEFT JOIN jobs j ON j.id = t.job_id
       WHERE t.assignee_id IN (${ph}) ORDER BY t.done, t.due_on`,
    )
    .all(...ids) as Array<Record<string, unknown>>;

  const updates = db
    .prepare(
      `SELECT e.kind, e.body, e.actor, e.created_at, e.job_id, j.title AS job
       FROM job_events e JOIN jobs j ON j.id = e.job_id
       WHERE j.assignee_id IN (${ph}) ORDER BY e.id DESC LIMIT 8`,
    )
    .all(...ids) as Array<Record<string, unknown>>;

  const stages = db
    .prepare(
      `SELECT stage, COUNT(*) AS n, COALESCE(SUM(value_cents),0) AS v
       FROM jobs WHERE assignee_id IN (${ph}) GROUP BY stage`,
    )
    .all(...ids) as Array<{ stage: string; n: number; v: number }>;

  const today = db
    .prepare(
      `SELECT j.id, j.title, j.address, j.trade, j.scheduled_for
       FROM jobs j WHERE j.assignee_id IN (${ph})
         AND j.scheduled_for IS NOT NULL AND date(j.scheduled_for) >= date('now')
       ORDER BY j.scheduled_for LIMIT 4`,
    )
    .all(...ids) as Array<Record<string, unknown>>;

  const money = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN i.status != 'Paid' THEN i.amount_cents END),0) AS outstanding,
         COALESCE(SUM(CASE WHEN i.status = 'Paid' AND i.paid_at > datetime('now','-30 days') THEN i.amount_cents END),0) AS collected
       FROM invoices i JOIN jobs j ON j.id = i.job_id WHERE j.assignee_id IN (${ph})`,
    )
    .get(...ids) as { outstanding: number; collected: number };

  const open = stages.filter((s) => s.stage !== "Closed");
  const pipeline = open.reduce((s, r) => s + r.v, 0);

  return (
    <div className="p-6">
      <h1 className="mb-1 text-xl font-semibold">
        Good morning, {user.name.split(" ")[0]}
      </h1>
      <p className="mb-5 text-sm text-[var(--muted)]">
        {tasks.filter((t) => !t.done).length} open tasks · {open.reduce((s, r) => s + r.n, 0)} live jobs
      </p>

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Tile label="Open pipeline" value={usd(pipeline)} />
        <Tile label="Outstanding invoices" value={usd(money.outstanding)} alert={money.outstanding > 0} />
        <Tile label="Collected (30d)" value={usd(money.collected)} />
        <Tile
          label="Scheduled next"
          value={today[0] ? String(today[0].scheduled_for) : "—"}
          sub={today[0] ? String(today[0].title) : undefined}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="My tasks" href="/jobs" hrefLabel="All jobs">
          {tasks.length === 0 ? (
            <p className="text-sm text-[var(--muted)]">Nothing assigned.</p>
          ) : (
            tasks.map((t) => {
              const toggle = toggleTask.bind(null, Number(t.id));
              const overdue = !t.done && String(t.due_on ?? "") < new Date().toISOString().slice(0, 10);
              return (
                <div key={String(t.id)} className="flex items-center gap-3 border-b border-[var(--card-border)] py-2 last:border-0">
                  <form action={toggle}>
                    <button
                      className={`h-4 w-4 rounded border ${t.done ? "border-emerald-500 bg-emerald-500" : "border-[var(--card-border)]"}`}
                      aria-label="toggle task"
                    />
                  </form>
                  <div className="min-w-0 flex-1">
                    <div className={`text-sm ${t.done ? "text-[var(--muted)] line-through" : ""}`}>
                      {String(t.title)}
                    </div>
                    {t.job ? (
                      <Link href={`/jobs/${t.job_id}`} className="text-xs text-[var(--accent-light)] hover:underline">
                        {String(t.job)}
                      </Link>
                    ) : null}
                  </div>
                  <span className={`shrink-0 text-xs ${overdue ? "text-red-600" : "text-[var(--muted)]"}`}>
                    {String(t.due_on ?? "")}
                  </span>
                </div>
              );
            })
          )}
        </Card>

        <Card title="Recent activity" href="/communications" hrefLabel="Inbox">
          {updates.map((u, i) => (
            <div key={i} className="border-b border-[var(--card-border)] py-2 text-sm last:border-0">
              <span className={`mr-2 rounded-full px-2 py-0.5 text-[10px] ${tone(String(u.kind) === "stage" ? "Sent" : "Draft")}`}>
                {String(u.kind)}
              </span>
              {String(u.body)}
              <div className="mt-0.5 text-xs text-[var(--muted)]">
                <Link href={`/jobs/${u.job_id}`} className="text-[var(--accent-light)] hover:underline">
                  {String(u.job)}
                </Link>{" "}
                · {String(u.actor)} · {daysSince(String(u.created_at))}d ago
              </div>
            </div>
          ))}
        </Card>

        <Card title="Pipeline" href="/jobs" hrefLabel="Board">
          {STAGES.filter((s) => s !== "Closed").map((s) => {
            const row = stages.find((r) => r.stage === s);
            const max = Math.max(1, ...open.map((r) => r.v));
            return (
              <div key={s} className="py-1.5">
                <div className="flex justify-between text-xs">
                  <span>
                    {s} <span className="text-[var(--muted)]">({row?.n ?? 0})</span>
                  </span>
                  <span className="tabular-nums text-[var(--muted)]">{usd(row?.v ?? 0)}</span>
                </div>
                <div className="mt-1 h-2 rounded bg-black/5">
                  <div
                    className="h-2 rounded bg-[var(--accent-light)]"
                    style={{ width: `${Math.max(1.5, ((row?.v ?? 0) / max) * 100)}%` }}
                  />
                </div>
              </div>
            );
          })}
        </Card>

        <Card title="Upcoming production" href="/calendar" hrefLabel="Calendar">
          {today.length === 0 ? (
            <p className="text-sm text-[var(--muted)]">Nothing scheduled.</p>
          ) : (
            today.map((j) => (
              <Link
                key={String(j.id)}
                href={`/jobs/${j.id}`}
                className="flex items-center justify-between border-b border-[var(--card-border)] py-2 text-sm last:border-0 hover:text-[var(--accent-light)]"
              >
                <span>
                  <span className="mr-2 font-mono text-xs text-[var(--muted)]">{String(j.scheduled_for)}</span>
                  {String(j.title)}
                </span>
                <span className="rounded-full bg-black/5 px-2 py-0.5 text-xs">{String(j.trade)}</span>
              </Link>
            ))
          )}
        </Card>
      </div>
    </div>
  );
}

function Tile({ label, value, sub, alert }: { label: string; value: string; sub?: string; alert?: boolean }) {
  return (
    <div className="rounded-xl border border-[var(--card-border)] bg-[var(--card)] p-4">
      <div className="text-xs text-[var(--muted)]">{label}</div>
      <div className={`mt-1 text-2xl font-semibold ${alert ? "text-amber-700" : ""}`}>{value}</div>
      {sub ? <div className="mt-0.5 truncate text-xs text-[var(--muted)]">{sub}</div> : null}
    </div>
  );
}

function Card({
  title,
  href,
  hrefLabel,
  children,
}: {
  title: string;
  href?: string;
  hrefLabel?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-[var(--card-border)] bg-[var(--card)]">
      <div className="flex items-center justify-between border-b border-[var(--card-border)] p-4">
        <h2 className="font-semibold">{title}</h2>
        {href ? (
          <Link href={href} className="text-sm text-[var(--accent-light)] hover:underline">
            {hrefLabel}
          </Link>
        ) : null}
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}
