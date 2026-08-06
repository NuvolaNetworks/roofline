import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getDb, STAGES, COMMISSION_RATE } from "@/lib/db";
import { currentUser, visibleUserIds } from "@/lib/auth";
import {
  advanceStage,
  addNote,
  orderMeasurement,
  createProposalFromMeasurement,
  createDocument,
  createMaterialOrder,
  createWorkOrder,
  createInvoice,
} from "@/lib/actions";
import { usd, usd2, daysSince, tone } from "@/lib/fmt";

export const dynamic = "force-dynamic";

export default async function JobPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) redirect("/login");
  const { id } = await params;
  const jobId = Number(id);
  const db = getDb();

  const job = db
    .prepare(
      `SELECT j.*, u.name AS assignee, c.name AS contact, c.phone, c.email AS contact_email
       FROM jobs j LEFT JOIN users u ON u.id = j.assignee_id
       LEFT JOIN contacts c ON c.id = j.contact_id WHERE j.id = ?`,
    )
    .get(jobId) as Record<string, unknown> | undefined;
  if (!job) notFound();
  if (!visibleUserIds(user).includes(Number(job.assignee_id))) notFound();

  const rows = <T,>(sql: string) => db.prepare(sql).all(jobId) as T[];
  const events = rows<Record<string, unknown>>("SELECT * FROM job_events WHERE job_id = ? ORDER BY id DESC");
  const measurements = rows<Record<string, unknown>>("SELECT * FROM measurements WHERE job_id = ? ORDER BY id DESC");
  const proposals = rows<Record<string, unknown>>("SELECT * FROM proposals WHERE job_id = ? ORDER BY id DESC");
  const documents = rows<Record<string, unknown>>(
    "SELECT d.*, t.name AS template FROM documents d LEFT JOIN templates t ON t.id = d.template_id WHERE d.job_id = ? ORDER BY d.id DESC",
  );
  const materials = rows<Record<string, unknown>>("SELECT * FROM material_orders WHERE job_id = ? ORDER BY id DESC");
  const works = rows<Record<string, unknown>>("SELECT * FROM work_orders WHERE job_id = ? ORDER BY id DESC");
  const invoices = rows<Record<string, unknown>>("SELECT * FROM invoices WHERE job_id = ? ORDER BY id DESC");
  const templates = db.prepare("SELECT id, name FROM templates WHERE kind != 'proposal'").all() as Array<{
    id: number;
    name: string;
  }>;

  const stage = String(job.stage);
  const stageIdx = STAGES.indexOf(stage as (typeof STAGES)[number]);
  const value = Number(job.value_cents);
  const cost = Number(job.cost_cents);
  const paid = invoices.filter((i) => i.status === "Paid").reduce((s, i) => s + Number(i.amount_cents), 0);

  const advance = advanceStage.bind(null, jobId);
  const order = orderMeasurement.bind(null, jobId);
  const draftProposal = createProposalFromMeasurement.bind(null, jobId);
  const newDoc = createDocument.bind(null, jobId);
  const newMaterial = createMaterialOrder.bind(null, jobId);
  const newWork = createWorkOrder.bind(null, jobId);
  const note = addNote.bind(null, jobId);
  const depositInvoice = createInvoice.bind(null, jobId, "Deposit");
  const balanceInvoice = createInvoice.bind(null, jobId, "Balance");

  const btn =
    "rounded-lg border border-[var(--card-border)] px-3 py-1.5 text-sm hover:bg-black/5";
  const input = "rounded-lg border border-[var(--card-border)] px-3 py-1.5 text-sm";

  return (
    <div className="max-w-5xl p-6">
      <div className="mb-1 flex flex-wrap gap-x-1 text-xs text-[var(--muted)]">
        {STAGES.map((s, i) => (
          <span key={s} className={i === stageIdx ? "font-semibold text-[var(--accent)]" : ""}>
            {s}
            {i < STAGES.length - 1 ? " →" : ""}
          </span>
        ))}
      </div>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">{String(job.title)}</h1>
          <p className="text-sm text-[var(--muted)]">
            {String(job.address)} · {String(job.trade)} · {String(job.workflow)} · source: {String(job.source)}
          </p>
          <p className="mt-1 text-sm">
            {String(job.contact)} · {String(job.phone ?? "")} · {String(job.contact_email ?? "")}
          </p>
          <p className="mt-1 text-xs text-[var(--muted)]">
            {daysSince(String(job.stage_since))}d in {stage}
            {job.scheduled_for ? ` · scheduled ${String(job.scheduled_for)}` : ""}
          </p>
        </div>
        <div className="text-right">
          <div className="text-lg font-semibold tabular-nums">{value > 0 ? usd(value) : "unquoted"}</div>
          {value > 0 ? (
            <div className="text-xs text-[var(--muted)]">
              cost {usd(cost)} · margin {usd(value - cost)} ({Math.round(((value - cost) / value) * 100)}%) ·
              commission {usd(Math.round((value - cost) * COMMISSION_RATE))}
            </div>
          ) : null}
          <div className="text-xs text-[var(--muted)]">
            collected {usd(paid)} of {usd(value)} · rep {String(job.assignee)}
          </div>
          {stageIdx >= 0 && stageIdx < STAGES.length - 1 ? (
            <form action={advance} className="mt-2">
              <button className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-sm text-white hover:bg-[var(--accent-light)]">
                Move to {STAGES[stageIdx + 1]}
              </button>
            </form>
          ) : null}
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Panel title="Measurements">
          {measurements.map((m) => (
            <div key={String(m.id)} className="mb-2 rounded-lg bg-black/5 p-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="font-medium">{String(m.provider).replaceAll("_", " ")}</span>
                <span className={`rounded-full px-2 py-0.5 text-[11px] ${tone(m.status === "delivered" ? "Signed" : "Sent")}`}>
                  {String(m.status)}
                </span>
              </div>
              {m.total_squares ? (
                <div className="mt-1 grid grid-cols-3 gap-1 text-xs text-[var(--muted)]">
                  <span>{Number(m.total_squares)} squares</span>
                  <span>pitch {String(m.pitch)}</span>
                  {m.ridge_ft ? <span>ridge {Number(m.ridge_ft)}ft</span> : <span>rough estimate</span>}
                  {m.hip_ft ? <span>hip {Number(m.hip_ft)}ft</span> : null}
                  {m.valley_ft ? <span>valley {Number(m.valley_ft)}ft</span> : null}
                  {m.eave_ft ? <span>eave {Number(m.eave_ft)}ft</span> : null}
                  {m.rake_ft ? <span>rake {Number(m.rake_ft)}ft</span> : null}
                </div>
              ) : (
                <div className="mt-1 text-xs text-[var(--muted)]">report ordered — awaiting delivery</div>
              )}
            </div>
          ))}
          <div className="flex flex-wrap gap-2">
            <form action={order}>
              <button className={btn}>Order QuickMeasure report</button>
            </form>
            <form action={draftProposal}>
              <button className={btn}>Build proposal from measurement</button>
            </form>
          </div>
        </Panel>

        <Panel title="Proposals" href="/proposals">
          {proposals.length === 0 ? (
            <p className="text-sm text-[var(--muted)]">No proposal yet.</p>
          ) : (
            proposals.map((p) => (
              <Link
                key={String(p.id)}
                href={`/proposals/${p.id}`}
                className="flex items-center justify-between border-b border-[var(--card-border)] py-2 text-sm last:border-0 hover:text-[var(--accent-light)]"
              >
                <span>{String(p.name)}</span>
                <span className="flex items-center gap-2">
                  <span className="tabular-nums">{usd(Number(p.total_cents))}</span>
                  <span className={`rounded-full px-2 py-0.5 text-[11px] ${tone(String(p.status))}`}>
                    {String(p.status)}
                  </span>
                </span>
              </Link>
            ))
          )}
        </Panel>

        <Panel title="Documents & signatures" href="/documents">
          {documents.map((d) => (
            <div key={String(d.id)} className="flex items-center justify-between border-b border-[var(--card-border)] py-2 text-sm last:border-0">
              <span>{String(d.name)}</span>
              <span className={`rounded-full px-2 py-0.5 text-[11px] ${tone(String(d.status))}`}>
                {String(d.status)}
                {d.signed_at ? ` · ${String(d.signed_at).slice(0, 10)}` : ""}
              </span>
            </div>
          ))}
          <form action={newDoc} className="mt-2 flex gap-2">
            <select name="template_id" className={input}>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            <button className={btn}>Send for signature</button>
          </form>
        </Panel>

        <Panel title="Orders" href="/orders">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">Materials</div>
          {materials.map((m) => (
            <div key={String(m.id)} className="flex items-center justify-between border-b border-[var(--card-border)] py-2 text-sm last:border-0">
              <span>
                {String(m.supplier)}
                {m.deliver_on ? <span className="text-[var(--muted)]"> · deliver {String(m.deliver_on)}</span> : null}
              </span>
              <span className="flex items-center gap-2">
                <span className="tabular-nums">{usd(Number(m.total_cents))}</span>
                <span className={`rounded-full px-2 py-0.5 text-[11px] ${tone(String(m.status))}`}>{String(m.status)}</span>
              </span>
            </div>
          ))}
          <form action={newMaterial} className="mt-1">
            <button className={btn}>Order materials from proposal</button>
          </form>

          <div className="mb-2 mt-4 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">Work orders</div>
          {works.map((w) => (
            <div key={String(w.id)} className="flex items-center justify-between border-b border-[var(--card-border)] py-2 text-sm last:border-0">
              <span>
                {String(w.crew)} <span className="text-[var(--muted)]">· {String(w.trade)}</span>
              </span>
              <span className="flex items-center gap-2">
                <span className="tabular-nums">{usd(Number(w.amount_cents))}</span>
                <span className={`rounded-full px-2 py-0.5 text-[11px] ${tone(String(w.status))}`}>{String(w.status)}</span>
              </span>
            </div>
          ))}
          <form action={newWork} className="mt-2 flex flex-wrap gap-2">
            <input name="crew" placeholder="Crew / sub" className={`${input} w-36`} />
            <input name="trade" placeholder="Trade" defaultValue={String(job.trade)} className={`${input} w-28`} />
            <input name="amount" placeholder="$" className={`${input} w-20`} />
            <input name="scheduled_for" type="date" className={input} />
            <button className={btn}>Send work order</button>
          </form>
        </Panel>

        <Panel title="Invoices & payments" href="/invoices">
          {invoices.map((i) => (
            <div key={String(i.id)} className="flex items-center justify-between border-b border-[var(--card-border)] py-2 text-sm last:border-0">
              <span>
                {String(i.kind)}
                <span className="text-[var(--muted)]"> · due {String(i.due_on ?? "—")}</span>
              </span>
              <span className="flex items-center gap-2">
                <span className="tabular-nums">{usd2(Number(i.amount_cents))}</span>
                <span className={`rounded-full px-2 py-0.5 text-[11px] ${tone(String(i.status))}`}>{String(i.status)}</span>
              </span>
            </div>
          ))}
          <div className="mt-2 flex gap-2">
            <form action={depositInvoice}>
              <button className={btn}>Send deposit invoice</button>
            </form>
            <form action={balanceInvoice}>
              <button className={btn}>Send balance invoice</button>
            </form>
          </div>
        </Panel>

        <Panel title="Communication">
          <form action={note} className="mb-3 flex gap-2">
            <select name="kind" className={input}>
              <option value="note">Note</option>
              <option value="email">Email</option>
              <option value="sms">SMS</option>
            </select>
            <input name="body" placeholder="Message or note…" className={`${input} flex-1`} />
            <button className="rounded-lg bg-[var(--accent)] px-3 text-sm text-white">Add</button>
          </form>
          <div className="max-h-64 space-y-2 overflow-y-auto">
            {events.map((e) => (
              <div key={String(e.id)} className="text-sm">
                <span
                  className={`mr-2 rounded-full px-2 py-0.5 text-[10px] ${
                    e.kind === "stage" ? "bg-blue-100 text-blue-800"
                    : e.kind === "email" ? "bg-amber-100 text-amber-800"
                    : e.kind === "sms" ? "bg-teal-100 text-teal-800"
                    : "bg-black/5 text-[var(--muted)]"
                  }`}
                >
                  {String(e.kind)}
                </span>
                {String(e.body)}
                <span className="ml-1 text-xs text-[var(--muted)]">
                  — {String(e.actor)}, {String(e.created_at).slice(0, 16)}
                </span>
              </div>
            ))}
          </div>
        </Panel>
      </div>
    </div>
  );
}

function Panel({ title, href, children }: { title: string; href?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-[var(--card-border)] bg-[var(--card)] p-4">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="font-semibold">{title}</h2>
        {href ? (
          <Link href={href} className="text-xs text-[var(--accent-light)] hover:underline">
            view all
          </Link>
        ) : null}
      </div>
      {children}
    </section>
  );
}
