import { redirect } from "next/navigation";
import { getDb } from "@/lib/db";
import { currentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function Catalogue() {
  const user = await currentUser();
  if (!user) redirect("/login");
  const items = await getDb().all(
    "SELECT * FROM catalogue WHERE org_id = ? ORDER BY source DESC, name",
    user.org_id,
  );
  return (
    <div className="p-6 max-w-3xl">
      <h1 className="mb-1 text-xl font-semibold">Catalogue</h1>
      <p className="mb-4 text-sm text-[var(--muted)]">
        SRS Roof Hub items carry live pricing through the governed AMOS connection;
        custom items (labor etc.) are yours.
      </p>
      <div className="rounded-xl border border-[var(--card-border)] bg-[var(--card)]">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--card-border)] text-left text-[var(--muted)]">
              <th className="px-4 py-3 font-medium">SKU</th>
              <th className="px-4 py-3 font-medium">Item</th>
              <th className="px-4 py-3 font-medium">Unit</th>
              <th className="px-4 py-3 font-medium text-right">Price</th>
              <th className="px-4 py-3 font-medium">Source</th>
            </tr>
          </thead>
          <tbody>
            {items.map((i) => (
              <tr key={String(i.id)} className="border-b border-[var(--card-border)] last:border-0">
                <td className="px-4 py-3 font-mono text-xs">{String(i.sku)}</td>
                <td className="px-4 py-3">{String(i.name)}</td>
                <td className="px-4 py-3 text-[var(--muted)]">{String(i.unit)}</td>
                <td className="px-4 py-3 text-right tabular-nums">
                  ${(Number(i.price_cents) / 100).toFixed(2)}
                </td>
                <td className="px-4 py-3">
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs ${
                      i.source === "srs_roofhub"
                        ? "bg-blue-100 text-blue-800"
                        : "bg-black/5 text-[var(--muted)]"
                    }`}
                  >
                    {i.source === "srs_roofhub" ? "SRS Roof Hub" : "custom"}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
