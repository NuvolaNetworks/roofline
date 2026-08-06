import { redirect } from "next/navigation";
import { getDb } from "@/lib/db";
import { currentUser } from "@/lib/auth";
import { createLead } from "@/lib/actions";

export default async function NewLead() {
  const user = await currentUser();
  if (!user) redirect("/login");
  const reps = getDb()
    .prepare("SELECT id, name FROM users ORDER BY name")
    .all() as Array<{ id: number; name: string }>;
  const input =
    "w-full rounded-lg border border-[var(--card-border)] px-3 py-2 text-sm";
  return (
    <div className="p-6 max-w-lg">
      <h1 className="mb-1 text-xl font-semibold">New lead</h1>
      <p className="mb-4 text-sm text-[var(--muted)]">
        Door knocking, office call, referral, QR instant estimate — every source
        lands here and gets assigned.
      </p>
      <form action={createLead} className="space-y-3">
        <input name="name" required placeholder="Homeowner name" className={input} />
        <input name="address" required placeholder="Job address" className={input} />
        <div className="flex gap-3">
          <input name="phone" placeholder="Phone" className={input} />
          <input name="email" placeholder="Email" className={input} />
        </div>
        <div className="flex gap-3">
          <select name="trade" className={input}>
            {["Roofing", "Concrete", "Carpentry", "Remodel", "Gutters"].map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
          <select name="source" className={input}>
            {[
              "Door knocking",
              "Office call",
              "Referral",
              "Networking",
              "QR instant estimate",
              "Insurance referral",
            ].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </div>
        <select name="assignee" className={input} defaultValue={user.id}>
          {reps.map((r) => (
            <option key={r.id} value={r.id}>
              Assign to {r.name}
            </option>
          ))}
        </select>
        <input name="title" placeholder="Job title (optional)" className={input} />
        <button className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--accent-light)]">
          Create lead
        </button>
      </form>
    </div>
  );
}
