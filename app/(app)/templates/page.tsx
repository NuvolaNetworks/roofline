import Link from "next/link";
import { redirect } from "next/navigation";
import { getDb } from "@/lib/db";
import { currentUser } from "@/lib/auth";
import { createTemplate } from "@/lib/template-actions";

export const dynamic = "force-dynamic";

export default async function Templates({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const user = await currentUser();
  if (!user) redirect("/login");
  const { error } = await searchParams;
  const db = getDb();
  const templates = await db.all<{ id: number; name: string; updated_at: string | null; uses: number }>(
    `SELECT t.id, t.name, t.updated_at,
            (SELECT COUNT(*) FROM proposals p WHERE p.template_id = t.id AND p.org_id = t.org_id) AS uses
     FROM templates t WHERE t.org_id = ? AND t.kind = 'proposal' ORDER BY t.id`,
    user.org_id,
  );
  const canEdit = user.role !== "rep";
  return (
    <div className="max-w-3xl p-6">
      <h1 className="mb-1 text-xl font-semibold">Proposal templates</h1>
      <p className="mb-4 text-sm text-[var(--muted)]">
        Your branding, page order, spec sheets and terms. A proposal fills a template with the job&apos;s customer
        and line items — preview it, send it for e-signature, and the signed PDF lands on the job.
      </p>
      {error ? <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-800">{error}</div> : null}
      <div className="mb-6 rounded-xl border border-[var(--card-border)] bg-[var(--card)]">
        {templates.map((t) => (
          <div key={t.id} className="flex items-center justify-between border-b border-[var(--card-border)] px-4 py-3 text-sm last:border-0">
            <div>
              <Link href={`/templates/${t.id}`} className="font-medium text-[var(--accent-light)] hover:underline">{t.name}</Link>
              <div className="text-xs text-[var(--muted)]">
                used by {Number(t.uses)} proposal{Number(t.uses) === 1 ? "" : "s"}
                {t.updated_at ? ` · edited ${t.updated_at.slice(0, 10)}` : " · default layout"}
              </div>
            </div>
            <div className="flex gap-2">
              <a href={`/templates/${t.id}/pdf`} target="_blank" rel="noreferrer" className="rounded-lg border border-[var(--card-border)] px-3 py-1 text-xs hover:bg-black/5">Sample PDF</a>
              {canEdit ? (
                <form action={createTemplate}>
                  <input type="hidden" name="copy_from" value={t.id} />
                  <input type="hidden" name="name" value={`${t.name} (copy)`} />
                  <button className="rounded-lg border border-[var(--card-border)] px-3 py-1 text-xs hover:bg-black/5">Duplicate</button>
                </form>
              ) : null}
            </div>
          </div>
        ))}
      </div>
      {canEdit ? (
        <form action={createTemplate} className="flex gap-2">
          <input name="name" placeholder="New template name" className="flex-1 rounded-md border border-[var(--card-border)] bg-white px-3 py-1.5 text-sm" />
          <button className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-sm text-white hover:bg-[var(--accent-light)]">Create template</button>
        </form>
      ) : null}
    </div>
  );
}
