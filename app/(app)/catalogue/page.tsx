import { redirect } from "next/navigation";
import { getDb } from "@/lib/db";
import { currentUser } from "@/lib/auth";
import { addCatalogueItem, updateCatalogueItem } from "@/lib/catalogue-actions";

export const dynamic = "force-dynamic";

const input = "rounded-md border border-[var(--card-border)] bg-white px-2 py-1 text-sm";
const btn = "rounded-lg border border-[var(--card-border)] px-2.5 py-1 text-xs hover:bg-black/5";

export default async function Catalogue({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const user = await currentUser();
  if (!user) redirect("/login");
  const { error } = await searchParams;
  const items = await getDb().all<{
    id: number; sku: string; name: string; unit: string; price_cents: number; cost_cents: number; source: string;
    section: string; spec_file_id: number | null; spec_name: string | null;
  }>(
    `SELECT c.id, c.sku, c.name, c.unit, c.price_cents, c.cost_cents, c.source, c.section, c.spec_file_id, f.filename AS spec_name
     FROM catalogue c LEFT JOIN files f ON f.id = c.spec_file_id AND f.org_id = c.org_id
     WHERE c.org_id = ? ORDER BY c.source DESC, c.name`,
    user.org_id,
  );
  const canEdit = user.role !== "rep";
  return (
    <div className="max-w-5xl p-6">
      <h1 className="mb-1 text-xl font-semibold">Catalogue</h1>
      <p className="mb-4 text-sm text-[var(--muted)]">
        SRS Roof Hub items carry live pricing through the governed AMOS connection; custom items (labor etc.) are
        yours. The section is where an item lands on a proposal; a spec sheet is attached to any proposal that
        includes the item.
      </p>
      {error ? <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-800">{error}</div> : null}
      <div className="rounded-xl border border-[var(--card-border)] bg-[var(--card)]">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--card-border)] text-left text-[var(--muted)]">
              <th className="px-4 py-3 font-medium">Item</th>
              <th className="px-4 py-3 font-medium">Unit · price · cost</th>
              <th className="px-4 py-3 font-medium">Proposal section · spec sheet</th>
            </tr>
          </thead>
          <tbody>
            {items.map((i) => (
              <tr key={i.id} className="border-b border-[var(--card-border)] align-top last:border-0">
                <td className="px-4 py-3">
                  <div>{i.name}</div>
                  <div className="font-mono text-[11px] text-[var(--muted)]">
                    {i.sku} · {i.source === "srs_roofhub" ? "SRS Roof Hub" : "custom"}
                  </div>
                </td>
                <td className="px-4 py-3 tabular-nums">
                  {canEdit && i.source !== "srs_roofhub" ? (
                    <div className="flex gap-1">
                      <input form={`cat-${i.id}`} name="unit" defaultValue={i.unit} className={`${input} w-20`} aria-label="Unit" />
                      <input form={`cat-${i.id}`} name="price" defaultValue={(Number(i.price_cents) / 100).toFixed(2)} className={`${input} w-24 text-right`} aria-label="Price" />
                      <input form={`cat-${i.id}`} name="cost" defaultValue={(Number(i.cost_cents) / 100).toFixed(2)} className={`${input} w-24 text-right`} aria-label="Cost" />
                    </div>
                  ) : (
                    <span>
                      <span className="text-[var(--muted)]">{i.unit}</span> · ${(Number(i.price_cents) / 100).toFixed(2)}
                    </span>
                  )}
                </td>
                <td className="px-4 py-3">
                  <form id={`cat-${i.id}`} action={updateCatalogueItem.bind(null, Number(i.id))} className="flex flex-wrap items-center gap-2">
                    <input name="section" defaultValue={i.section} placeholder="e.g. Roofing Accessories" className={`${input} w-48`} disabled={!canEdit} />
                    {i.spec_file_id ? (
                      <>
                        <a href={`/files/${i.spec_file_id}`} target="_blank" rel="noreferrer" className="text-xs text-[var(--accent-light)] hover:underline">
                          {i.spec_name}
                        </a>
                        {canEdit ? (
                          <label className="flex items-center gap-1 text-xs"><input type="checkbox" name="remove_spec" value="yes" /> remove</label>
                        ) : null}
                      </>
                    ) : null}
                    {canEdit ? (
                      <>
                        <input type="file" name="spec" accept="application/pdf,image/png,image/jpeg" className="w-48 text-xs" />
                        <button className={btn}>Save</button>
                      </>
                    ) : null}
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {canEdit ? (
        <form action={addCatalogueItem} className="mt-4 flex flex-wrap gap-2 rounded-xl border border-dashed border-[var(--card-border)] p-3">
          <input name="name" placeholder="Item name (e.g. Malarkey Vista AR)" className={`${input} w-64`} />
          <input name="sku" placeholder="SKU (optional)" className={`${input} w-32`} />
          <input name="unit" placeholder="unit" className={`${input} w-20`} />
          <input name="price" placeholder="Price" className={`${input} w-24`} />
          <input name="cost" placeholder="Cost" className={`${input} w-24`} />
          <input name="section" placeholder="Proposal section" className={`${input} w-44`} />
          <button className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-sm text-white hover:bg-[var(--accent-light)]">Add item</button>
        </form>
      ) : null}
    </div>
  );
}
