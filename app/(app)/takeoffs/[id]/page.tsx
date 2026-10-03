import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getDb } from "@/lib/db";
import { currentUser, visibleUserIds } from "@/lib/auth";
import { FIELDS, getTakeoff } from "@/lib/takeoff";
import { approveTakeoffAction, retryTakeoffAction, saveTakeoffAction } from "@/lib/takeoff-actions";

export const dynamic = "force-dynamic";

const TRADE_LABEL = { roofing: "Roofing", pool: "Pool", construction: "New construction" } as const;
const CONF = {
  high: "bg-green-50 text-green-800",
  medium: "bg-amber-50 text-amber-800",
  low: "bg-red-50 text-red-800",
} as const;

export default async function TakeoffPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; saved?: string }>;
}) {
  const q = await searchParams;
  const user = await currentUser();
  if (!user) redirect("/login");
  const { id } = await params;
  const db = getDb();
  const t = await getTakeoff(db, user.org_id, Number(id));
  if (!t) notFound();
  const job = await db.get<{ title: string; assignee_id: number | null }>("SELECT title, assignee_id FROM jobs WHERE id = ? AND org_id = ?", t.job_id, user.org_id);
  if (!job || !(await visibleUserIds(user)).includes(Number(job.assignee_id))) notFound();
  const file = await db.get<{ filename: string }>("SELECT filename FROM files WHERE id = ? AND org_id = ?", t.file_id, user.org_id);
  const input = "w-28 rounded-md border border-[var(--card-border)] bg-white px-2 py-1 text-right text-sm tabular-nums";
  const locked = t.status === "Approved";

  return (
    <div className="max-w-5xl space-y-4 p-6">
      {t.status === "Reading" ? <meta httpEquiv="refresh" content="5" /> : null}
      <div>
        <Link href={`/jobs/${t.job_id}`} className="text-xs text-[var(--muted)] hover:underline">← {job.title}</Link>
        <h1 className="text-xl font-semibold">{TRADE_LABEL[t.trade]} takeoff from blueprints</h1>
        <p className="text-sm text-[var(--muted)]">
          <a href={`/files/${t.file_id}`} target="_blank" className="hover:underline">{file?.filename ?? "plans"}</a> · {t.status}
          {t.extracted ? ` · scale: ${t.extracted.scale}` : ""}
          {t.extracted?.sheets_read.length ? ` · sheets: ${t.extracted.sheets_read.join(", ")}` : ""}
        </p>
      </div>
      {q.error ? <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800">{q.error}</p> : null}
      {q.saved ? <p className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-800">Saved.</p> : null}

      {t.status === "Reading" ? (
        <p className="rounded-xl border border-[var(--card-border)] bg-[var(--card)] p-4 text-sm">
          AMOS is reading the plans. This usually takes one to three minutes; this page refreshes on its own.
        </p>
      ) : null}
      {t.status === "Failed" ? (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-900">
          <p>The plans couldn&apos;t be read: {t.error}</p>
          <div className="mt-2 flex gap-2">
            <form action={retryTakeoffAction.bind(null, t.id)}>
              <button className="rounded-lg border border-red-300 bg-white px-3 py-1">Try again</button>
            </form>
            <span className="self-center text-xs">or enter the numbers below by hand.</span>
          </div>
        </div>
      ) : null}
      {t.extracted?.warnings.length ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          <p className="font-medium">Check before approving</p>
          <ul className="ml-4 list-disc">{t.extracted.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
        </div>
      ) : null}

      {t.status !== "Reading" ? (
        <form action={saveTakeoffAction.bind(null, t.id)} className="rounded-xl border border-[var(--card-border)] bg-[var(--card)]">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--card-border)] text-left text-[var(--muted)]">
                <th className="px-4 py-2 font-medium">Quantity</th>
                <th className="px-4 py-2 font-medium">Read from plans</th>
                <th className="px-4 py-2 text-right font-medium">Use</th>
              </tr>
            </thead>
            <tbody>
              {FIELDS[t.trade].map((f) => {
                const e = t.extracted?.values[f.key];
                const reviewed = t.reviewed?.[f.key];
                return (
                  <tr key={f.key} className="border-b border-[var(--card-border)] align-top last:border-0">
                    <td className="px-4 py-2">{f.label}</td>
                    <td className="px-4 py-2 text-xs text-[var(--muted)]">
                      {e ? (
                        <>
                          <span className="tabular-nums text-[var(--ink)]">{e.value ?? "—"} {e.value !== null ? f.unit : ""}</span>{" "}
                          <span className={`rounded-full px-1.5 py-0.5 ${CONF[e.confidence]}`}>{e.confidence}</span>
                          {e.sheet ? ` · ${e.sheet}` : ""}
                          {e.note ? <div>{e.note}</div> : null}
                        </>
                      ) : "—"}
                    </td>
                    <td className="px-4 py-2 text-right">
                      <input name={`v_${f.key}`} defaultValue={reviewed ?? ""} disabled={locked} className={input} />{" "}
                      <span className="text-xs text-[var(--muted)]">{f.unit}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {locked ? (
            <p className="px-4 py-3 text-sm">
              Approved —{" "}
              {t.proposal_id ? <Link href={`/proposals/${t.proposal_id}`} className="text-[var(--accent)] hover:underline">open the proposal</Link> : null}
            </p>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--card-border)] px-4 py-3">
              <p className="text-xs text-[var(--muted)]">
                Blueprint reads are a starting point. Check every number against the plans; nothing is priced until you approve.
              </p>
              <div className="flex gap-2">
                <button className="rounded-lg border border-[var(--card-border)] px-3 py-1.5 text-sm hover:bg-black/5">Save</button>
                <button formAction={approveTakeoffAction.bind(null, t.id)} className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-sm text-white hover:bg-[var(--accent-light)]">
                  Approve &amp; draft proposal
                </button>
              </div>
            </div>
          )}
        </form>
      ) : null}
    </div>
  );
}
