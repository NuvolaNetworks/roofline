import { redirect } from "next/navigation";
import { getDb } from "@/lib/db";
import { currentUser } from "@/lib/auth";
import { saveIntegrationKey } from "@/lib/actions";

export const dynamic = "force-dynamic";

const INTEGRATIONS = [
  ["SRS Roof Hub", "Live pricing + material ordering", "key"],
  ["GAF QuickMeasure", "Roof measurement reports (order → auto-fill proposal)", "planned"],
  ["QuickBooks", "Invoices + payments sync", "planned"],
  ["Google Calendar", "Production calendar two-way sync", "planned"],
  ["DocuSign / built-in signer", "Contracts + Certificates of Completion", "planned"],
] as const;

export default async function Settings() {
  const user = await currentUser();
  if (!user) redirect("/login");
  const key = (
    getDb().prepare("SELECT value FROM settings WHERE key = 'srs_roofhub_key'").get() as
      | { value: string }
      | undefined
  )?.value;
  const masked = key ? `${key.slice(0, 2)}••••${key.slice(-1)}` : "";

  return (
    <div className="p-6 max-w-2xl">
      <h1 className="mb-4 text-xl font-semibold">Settings — integrations</h1>
      <div className="space-y-3">
        {INTEGRATIONS.map(([name, desc, kind]) => (
          <div key={name} className="rounded-xl border border-[var(--card-border)] bg-[var(--card)] p-4">
            <div className="flex items-center justify-between">
              <div>
                <div className="font-medium">{name}</div>
                <div className="text-sm text-[var(--muted)]">{desc}</div>
              </div>
              {kind === "planned" ? (
                <span className="rounded-full bg-black/5 px-2 py-0.5 text-xs text-[var(--muted)]">
                  planned
                </span>
              ) : user.role === "rep" ? (
                <span className="text-xs text-[var(--muted)]">admin only</span>
              ) : (
                <form action={saveIntegrationKey} className="flex items-center gap-2">
                  <input
                    name="srs_key"
                    placeholder={masked || "Integration key"}
                    className="rounded-lg border border-[var(--card-border)] px-3 py-1.5 text-sm"
                  />
                  <button className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-sm text-white">
                    {key ? "Rotate" : "Connect"}
                  </button>
                </form>
              )}
            </div>
          </div>
        ))}
      </div>
      <p className="mt-4 text-xs text-[var(--muted)]">
        Keys are stored server-side and never shown again in full. In the AMOS
        deployment they live in the platform secret store, injected at runtime.
      </p>
    </div>
  );
}
