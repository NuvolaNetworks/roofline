import { notFound, redirect } from "next/navigation";
import { getDb, STAGES } from "@/lib/db";
import { currentUser, visibleUserIds } from "@/lib/auth";
import { advanceStage, addNote, orderMeasurement } from "@/lib/actions";

export const dynamic = "force-dynamic";

export default async function JobPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) redirect("/login");
  const { id } = await params;
  const db = getDb();
  const job = db
    .prepare(
      `SELECT j.*, u.name AS assignee, c.name AS contact, c.phone, c.email AS contact_email
       FROM jobs j LEFT JOIN users u ON u.id = j.assignee_id
       LEFT JOIN contacts c ON c.id = j.contact_id WHERE j.id = ?`,
    )
    .get(Number(id)) as Record<string, unknown> | undefined;
  if (!job) notFound();
  if (!visibleUserIds(user).includes(Number(job.assignee_id))) notFound();

  const events = db
    .prepare("SELECT * FROM job_events WHERE job_id = ? ORDER BY id DESC")
    .all(Number(id)) as Array<Record<string, unknown>>;
  const measurements = db
    .prepare("SELECT * FROM measurements WHERE job_id = ? ORDER BY id DESC")
    .all(Number(id)) as Array<Record<string, unknown>>;

  const stage = String(job.stage);
  const stageIdx = STAGES.indexOf(stage as (typeof STAGES)[number]);
  const nextStage = stageIdx >= 0 && stageIdx < STAGES.length - 1 ? STAGES[stageIdx + 1] : null;
  const advance = advanceStage.bind(null, Number(id));
  const order = orderMeasurement.bind(null, Number(id));
  const note = addNote.bind(null, Number(id));

  return (
    <div className="p-6 max-w-4xl">
      <div className="mb-1 text-xs text-[var(--muted)]">
        {STAGES.map((s, i) => (
          <span key={s} className={i === stageIdx ? "font-semibold text-[var(--accent)]" : ""}>
            {s}
            {i < STAGES.length - 1 ? " → " : ""}
          </span>
        ))}
      </div>
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">{String(job.title)}</h1>
          <p className="text-sm text-[var(--muted)]">
            {String(job.address)} · {String(job.trade)} · source: {String(job.source)}
          </p>
          <p className="mt-1 text-sm">
            {String(job.contact)} · {String(job.phone ?? "")} · {String(job.contact_email ?? "")}
          </p>
        </div>
        <div className="text-right">
          <div className="text-lg font-semibold tabular-nums">
            {Number(job.value_cents) > 0
              ? `$${(Number(job.value_cents) / 100).toLocaleString()}`
              : "unquoted"}
          </div>
          <div className="text-xs text-[var(--muted)]">
            {Number(job.deposit_paid) ? "50% deposit paid" : "no deposit"} · rep: {String(job.assignee)}
          </div>
          {nextStage ? (
            <form action={advance} className="mt-2">
              <button className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-sm text-white hover:bg-[var(--accent-light)]">
                Move to {nextStage}
              </button>
            </form>
          ) : null}
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <section className="rounded-xl border border-[var(--card-border)] bg-[var(--card)] p-4">
          <h2 className="mb-2 font-semibold">Measurements</h2>
          {measurements.length === 0 ? (
            <p className="text-sm text-[var(--muted)]">No report yet.</p>
          ) : (
            measurements.map((m) => (
              <div key={String(m.id)} className="mb-2 rounded-lg bg-black/5 p-3 text-sm">
                <div className="font-medium">
                  {String(m.provider).replaceAll("_", " ")} · {String(m.status)}
                </div>
                <div className="mt-1 grid grid-cols-3 gap-1 text-xs text-[var(--muted)]">
                  <span>{Number(m.total_squares)} squares</span>
                  <span>pitch {String(m.pitch)}</span>
                  {m.ridge_ft ? <span>ridge {Number(m.ridge_ft)}ft</span> : <span>rough est.</span>}
                  {m.eave_ft ? <span>eave {Number(m.eave_ft)}ft</span> : null}
                  {m.valley_ft ? <span>valley {Number(m.valley_ft)}ft</span> : null}
                  {m.rake_ft ? <span>rake {Number(m.rake_ft)}ft</span> : null}
                </div>
              </div>
            ))
          )}
          <form action={order}>
            <button className="mt-1 rounded-lg border border-[var(--card-border)] px-3 py-1.5 text-sm hover:bg-black/5">
              Order QuickMeasure report
            </button>
          </form>
        </section>

        <section className="rounded-xl border border-[var(--card-border)] bg-[var(--card)] p-4">
          <h2 className="mb-2 font-semibold">Communication</h2>
          <form action={note} className="mb-3 flex gap-2">
            <input
              name="body"
              placeholder="Add a note to this job…"
              className="flex-1 rounded-lg border border-[var(--card-border)] px-3 py-1.5 text-sm"
            />
            <button className="rounded-lg bg-[var(--accent)] px-3 text-sm text-white">Add</button>
          </form>
          <div className="max-h-72 space-y-2 overflow-y-auto">
            {events.map((e) => (
              <div key={String(e.id)} className="text-sm">
                <span
                  className={`mr-2 rounded-full px-2 py-0.5 text-[10px] ${
                    e.kind === "stage"
                      ? "bg-blue-100 text-blue-800"
                      : e.kind === "email"
                        ? "bg-amber-100 text-amber-800"
                        : "bg-black/5 text-[var(--muted)]"
                  }`}
                >
                  {String(e.kind)}
                </span>
                {String(e.body)}
                <span className="ml-1 text-xs text-[var(--muted)]">
                  — {String(e.actor)}, {String(e.created_at)}
                </span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
