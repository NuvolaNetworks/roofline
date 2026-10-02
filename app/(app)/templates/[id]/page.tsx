import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getDb } from "@/lib/db";
import { currentUser } from "@/lib/auth";
import { BLOCK_LABELS, MERGE_FIELDS, parseTemplateBody, type Block } from "@/lib/doc-template";
import { fileMeta } from "@/lib/files";
import { orgName, sampleModel, templateFileIds } from "@/lib/proposal-data";
import {
  addBlock,
  deleteBlock,
  moveBlock,
  removeAttachment,
  updateBlock,
  updateBranding,
  uploadAttachment,
} from "@/lib/template-actions";
import ProposalDocument from "@/components/ProposalDocument";

export const dynamic = "force-dynamic";

const input = "w-full rounded-md border border-[var(--card-border)] bg-white px-2 py-1.5 text-sm";
const btn = "rounded-lg border border-[var(--card-border)] px-2.5 py-1 text-xs hover:bg-black/5 disabled:opacity-40";
const primary = "rounded-lg bg-[var(--accent)] px-3 py-1.5 text-sm text-white hover:bg-[var(--accent-light)]";
const label = "mb-1 block text-xs font-medium text-[var(--muted)]";

function Check({ name, on, children }: { name: string; on: boolean; children: React.ReactNode }) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" name={name} value="yes" defaultChecked={on} />
      {children}
    </label>
  );
}

function BlockFields({ block, attachments }: { block: Block; attachments: Map<number, { filename: string }> }) {
  switch (block.type) {
    case "cover":
      return <p className="text-xs text-[var(--muted)]">Logo, stats and tagline come from Branding; customer and rep fill in per proposal.</p>;
    case "line_items":
      return (
        <div className="flex flex-wrap gap-4">
          <Check name="show_prices" on={block.show_prices}>Show line prices</Check>
          <Check name="show_subtotal" on={block.show_subtotal}>Show subtotal</Check>
        </div>
      );
    case "summary":
      return (
        <div className="space-y-2">
          <div>
            <span className={label}>Intro</span>
            <textarea name="intro" defaultValue={block.intro} rows={2} className={input} />
          </div>
          <div>
            <span className={label}>Agreement sentence under the signatures</span>
            <textarea name="consent" defaultValue={block.consent} rows={2} className={input} />
          </div>
          <Check name="contractor_signs" on={block.contractor_signs}>Rep countersigns</Check>
        </div>
      );
    case "attachments":
      return (
        <div className="space-y-2">
          <Check name="include_catalogue_specs" on={block.include_catalogue_specs}>
            Include spec sheets of catalog items on the proposal
          </Check>
          {block.file_ids.length ? (
            <ul className="text-xs text-[var(--muted)]">
              {block.file_ids.map((f) => (
                <li key={f}>· {attachments.get(f)?.filename ?? `file ${f} (missing)`}</li>
              ))}
            </ul>
          ) : null}
        </div>
      );
    case "text":
      return (
        <div>
          <textarea name="body" defaultValue={block.body} rows={Math.min(24, Math.max(6, block.body.split("\n").length + 1))} className={`${input} font-mono text-xs`} />
          <p className="mt-1 text-[11px] text-[var(--muted)]">
            <code>## Heading</code> for numbered sections · <code>- item</code> for bullets · blank line between paragraphs
          </p>
        </div>
      );
  }
}

export default async function TemplateEditor({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const user = await currentUser();
  if (!user) redirect("/login");
  const { id } = await params;
  const { error } = await searchParams;
  const tid = Number(id);
  const db = getDb();
  const row = await db.get<{ id: number; name: string; kind: string; body: string | null }>(
    "SELECT id, name, kind, body FROM templates WHERE id = ? AND org_id = ? AND kind = 'proposal'",
    tid, user.org_id,
  );
  if (!row) notFound();
  const body = parseTemplateBody(row.body, await orgName(db, user.org_id));
  const files = await fileMeta(db, user.org_id, templateFileIds(body));
  const model = await sampleModel(db, user.org_id, row, user);
  const canEdit = user.role !== "rep";
  const b = body.branding;
  const stats = [0, 1, 2, 3].map((i) => b.stats[i] ?? { value: "", label: "" });

  return (
    <div className="grid gap-6 p-6 xl:grid-cols-[minmax(0,460px)_minmax(0,1fr)]">
      <div>
        <div className="mb-3 flex items-center justify-between">
          <Link href="/templates" className="text-xs text-[var(--accent-light)] hover:underline">← Templates</Link>
          <a href={`/templates/${tid}/pdf`} target="_blank" rel="noreferrer" className={btn}>Sample PDF</a>
        </div>
        {error ? <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</div> : null}
        {!canEdit ? (
          <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">Only admins and managers can edit templates.</p>
        ) : null}

        <fieldset disabled={!canEdit} className="space-y-4">
          <form action={updateBranding.bind(null, tid)} className="space-y-3 rounded-xl border border-[var(--card-border)] bg-[var(--card)] p-4">
            <h2 className="font-semibold">Branding</h2>
            <div>
              <span className={label}>Template name</span>
              <input name="name" defaultValue={row.name} className={input} />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <span className={label}>Company name</span>
                <input name="company_name" defaultValue={b.company_name} className={input} />
              </div>
              <div>
                <span className={label}>Office phone</span>
                <input name="phone" defaultValue={b.phone} className={input} />
              </div>
            </div>
            <div>
              <span className={label}>Tagline</span>
              <input name="tagline" defaultValue={b.tagline} className={input} />
            </div>
            <div className="grid grid-cols-[auto_1fr] items-end gap-3">
              <div>
                <span className={label}>Accent</span>
                <input type="color" name="accent" defaultValue={b.accent} className="h-9 w-14 rounded border border-[var(--card-border)]" />
              </div>
              <div>
                <span className={label}>Logo (PNG or JPEG){b.logo_file_id ? " — uploaded" : ""}</span>
                <input type="file" name="logo" accept="image/png,image/jpeg" className="text-xs" />
                {b.logo_file_id ? (
                  <label className="mt-1 flex items-center gap-1 text-xs">
                    <input type="checkbox" name="remove_logo" value="yes" /> remove logo
                  </label>
                ) : null}
              </div>
            </div>
            <div>
              <span className={label}>Payment instructions (printed on invoices)</span>
              <textarea
                name="payment_instructions"
                defaultValue={b.payment_instructions}
                rows={3}
                placeholder={"Make checks payable to …\nMail to …\nACH: routing … account …"}
                className={input}
              />
            </div>
            <div>
              <span className={label}>Cover stats (up to four)</span>
              <div className="grid grid-cols-2 gap-2">
                {stats.map((s, i) => (
                  <div key={i} className="flex gap-1">
                    <input name={`stat_value_${i}`} defaultValue={s.value} placeholder="25" className={`${input} w-20`} />
                    <input name={`stat_label_${i}`} defaultValue={s.label} placeholder="Years in business" className={input} />
                  </div>
                ))}
              </div>
            </div>
            <button className={primary}>Save branding</button>
          </form>

          <div className="rounded-xl border border-[var(--card-border)] bg-[var(--card)] p-4">
            <h2 className="mb-1 font-semibold">Pages</h2>
            <p className="mb-3 text-xs text-[var(--muted)]">
              In order. Fill-ins:{" "}
              {MERGE_FIELDS.map(([k]) => (
                <code key={k} className="mr-1 rounded bg-black/5 px-1">{`{{${k}}}`}</code>
              ))}
            </p>
            <div className="space-y-3">
              {body.blocks.map((blk, i) => (
                <div key={blk.id} className="rounded-lg border border-[var(--card-border)] p-3">
                  <form action={updateBlock.bind(null, tid, blk.id)} className="space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">{BLOCK_LABELS[blk.type]}</span>
                      <span className="flex gap-1">
                        <button formAction={moveBlock.bind(null, tid, blk.id, -1)} disabled={i === 0} className={btn} aria-label="Move up">↑</button>
                        <button formAction={moveBlock.bind(null, tid, blk.id, 1)} disabled={i === body.blocks.length - 1} className={btn} aria-label="Move down">↓</button>
                        <button formAction={deleteBlock.bind(null, tid, blk.id)} className={`${btn} text-red-700`} aria-label="Remove page">✕</button>
                      </span>
                    </div>
                    <input name="title" defaultValue={blk.title} placeholder="Page title" className={input} />
                    <BlockFields block={blk} attachments={files} />
                    <button className={btn}>Save</button>
                  </form>
                  {blk.type === "attachments" ? (
                    <div className="mt-2 space-y-1 border-t border-[var(--card-border)] pt-2">
                      {blk.file_ids.map((f) => (
                        <form key={f} action={removeAttachment.bind(null, tid, blk.id, f)} className="flex items-center justify-between text-xs">
                          <a href={`/files/${f}`} target="_blank" rel="noreferrer" className="text-[var(--accent-light)] hover:underline">
                            {files.get(f)?.filename ?? `file ${f}`}
                          </a>
                          <button className={btn}>Remove</button>
                        </form>
                      ))}
                      <form action={uploadAttachment.bind(null, tid, blk.id)} className="flex items-center gap-2">
                        <input type="file" name="files" multiple accept="application/pdf,image/png,image/jpeg" className="text-xs" />
                        <button className={btn}>Upload</button>
                      </form>
                      <p className="text-[11px] text-[var(--muted)]">
                        Always-included PDFs. Product spec sheets are better attached to the item in the Catalog, so they appear only when that item is on the proposal.
                      </p>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
            <form action={addBlock.bind(null, tid)} className="mt-3 flex gap-2">
              <select name="type" className={input} defaultValue="text">
                {Object.entries(BLOCK_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </select>
              <button className={primary}>Add page</button>
            </form>
          </div>
        </fieldset>
      </div>

      <div>
        <h2 className="mb-2 font-semibold">Preview <span className="text-xs font-normal text-[var(--muted)]">(sample customer and items)</span></h2>
        <div className="rounded-xl bg-neutral-200 p-4">
          <ProposalDocument
            model={model}
            logoSrc={model.logo ? `/files/${model.logo.file_id}` : null}
            attachmentHref={(f) => `/files/${f}`}
          />
        </div>
      </div>
    </div>
  );
}
