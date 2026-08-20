import { redirect } from "next/navigation";
import { getDb } from "@/lib/db";
import { currentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function Contacts() {
  const user = await currentUser();
  if (!user) redirect("/login");
  const contacts = await getDb().all(
    "SELECT * FROM contacts WHERE org_id = ? ORDER BY type, name",
    user.org_id,
  );
  return (
    <div className="p-6 max-w-3xl">
      <h1 className="mb-4 text-xl font-semibold">Contacts</h1>
      <div className="rounded-xl border border-[var(--card-border)] bg-[var(--card)]">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--card-border)] text-left text-[var(--muted)]">
              <th className="px-4 py-3 font-medium">Name</th>
              <th className="px-4 py-3 font-medium">Type</th>
              <th className="px-4 py-3 font-medium">Phone</th>
              <th className="px-4 py-3 font-medium">Email</th>
            </tr>
          </thead>
          <tbody>
            {contacts.map((c) => (
              <tr key={String(c.id)} className="border-b border-[var(--card-border)] last:border-0">
                <td className="px-4 py-3">{String(c.name)}</td>
                <td className="px-4 py-3">
                  <span className="rounded-full bg-black/5 px-2 py-0.5 text-xs">{String(c.type)}</span>
                </td>
                <td className="px-4 py-3 text-[var(--muted)]">{String(c.phone ?? "")}</td>
                <td className="px-4 py-3 text-[var(--muted)]">{String(c.email ?? "")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
