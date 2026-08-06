import { redirect } from "next/navigation";
import { getDb } from "@/lib/db";
import { currentUser } from "@/lib/auth";
import { toggleAutomation } from "@/lib/actions";

export const dynamic = "force-dynamic";

export default async function Automations() {
  if (!(await currentUser())) redirect("/login");
  const rows = getDb().prepare("SELECT * FROM automations ORDER BY id").all() as Array<Record<string, unknown>>;
  return (
    <div className="max-w-3xl p-6">
      <h1 className="mb-1 text-xl font-semibold">Automations</h1>
      <p className="mb-4 text-sm text-[var(--muted)]">
        When something happens on a job, do something. Sends run through the AMOS email engine and Twilio
        connection — so an automation still can&apos;t message a homeowner outside policy.
      </p>
      <div className="space-y-2">
        {rows.map((a) => {
          const toggle = toggleAutomation.bind(null, Number(a.id));
          const on = Number(a.enabled) === 1;
          return (
            <div key={String(a.id)} className="flex items-center justify-between rounded-xl border border-[var(--card-border)] bg-[var(--card)] p-4">
              <div className="min-w-0">
                <div className="font-medium">{String(a.name)}</div>
                <div className="text-sm text-[var(--muted)]">
                  <span className="font-medium">When</span> {String(a.trigger)} → <span className="font-medium">then</span>{" "}
                  {String(a.action)}
                </div>
                <div className="mt-0.5 text-xs text-[var(--muted)]">
                  via {String(a.channel)} · {String(a.runs)} runs
                </div>
              </div>
              <form action={toggle}>
                <button
                  className={`rounded-full px-3 py-1 text-xs ${on ? "bg-emerald-100 text-emerald-800" : "bg-black/5 text-[var(--muted)]"}`}
                >
                  {on ? "Enabled" : "Off"}
                </button>
              </form>
            </div>
          );
        })}
      </div>
    </div>
  );
}
