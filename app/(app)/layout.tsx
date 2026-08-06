import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { logoutAction } from "@/lib/actions";

const MAIN = [
  ["/", "Home"],
  ["/jobs", "Jobs"],
  ["/calendar", "Calendar"],
  ["/performance", "Performance"],
] as const;

const TOOLS = [
  ["/estimate", "Instant Estimator"],
  ["/measurements", "Measurements"],
  ["/proposals", "Proposals"],
  ["/documents", "PDF Signer"],
  ["/orders", "Material & Work Orders"],
  ["/invoices", "Invoices"],
  ["/payments", "Payments"],
] as const;

const MANAGE = [
  ["/contacts", "Contacts"],
  ["/catalogue", "Catalog"],
  ["/automations", "Automations"],
  ["/communications", "Communications"],
  ["/settings", "Settings"],
] as const;

function Section({ title, items }: { title?: string; items: ReadonlyArray<readonly [string, string]> }) {
  return (
    <>
      {title ? (
        <div className="px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-[var(--muted)]">
          {title}
        </div>
      ) : null}
      {items.map(([href, label]) => (
        <Link
          key={href}
          href={href}
          className="block rounded-md px-3 py-1.5 text-sm text-[var(--muted)] hover:bg-black/5 hover:text-[var(--ink)]"
        >
          {label}
        </Link>
      ))}
    </>
  );
}

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();
  if (!user) redirect("/login");
  return (
    <div className="flex h-screen overflow-hidden">
      <aside className="flex w-56 shrink-0 flex-col border-r border-[var(--card-border)] bg-[var(--card)]">
        <div className="flex items-center gap-2 border-b border-[var(--card-border)] p-4">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--accent)] font-bold text-white">
            R
          </div>
          <div>
            <div className="text-sm font-semibold leading-tight">Roofline</div>
            <div className="text-[11px] leading-tight text-[var(--muted)]">
              {user.name} · {user.role}
            </div>
          </div>
        </div>
        <nav className="flex-1 overflow-y-auto p-2">
          <Section items={MAIN} />
          <Section title="Tools" items={TOOLS} />
          <Section title="Manage" items={MANAGE} />
        </nav>
        <div className="border-t border-[var(--card-border)] p-3">
          <form action={logoutAction}>
            <button className="w-full rounded-md px-3 py-1.5 text-left text-sm text-[var(--muted)] hover:bg-black/5">
              Sign out
            </button>
          </form>
          <p className="px-3 pt-1 text-[10px] text-[var(--muted)]">powered by AMOS</p>
        </div>
      </aside>
      <main className="flex-1 overflow-y-auto">{children}</main>
    </div>
  );
}
