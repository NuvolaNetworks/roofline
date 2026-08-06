import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { logoutAction } from "@/lib/actions";

const NAV = [
  { href: "/", label: "Jobs" },
  { href: "/calendar", label: "Calendar" },
  { href: "/performance", label: "Performance" },
  { href: "/leads/new", label: "New lead" },
  { href: "/contacts", label: "Contacts" },
  { href: "/catalogue", label: "Catalogue" },
  { href: "/settings", label: "Settings" },
];

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();
  if (!user) redirect("/login");
  return (
    <div className="flex h-screen overflow-hidden">
      <aside className="w-56 shrink-0 border-r border-[var(--card-border)] bg-[var(--card)] flex flex-col">
        <div className="p-4 border-b border-[var(--card-border)] flex items-center gap-2">
          <div className="h-8 w-8 rounded-lg bg-[var(--accent)] text-white flex items-center justify-center font-bold">
            R
          </div>
          <div>
            <div className="text-sm font-semibold leading-tight">Roofline</div>
            <div className="text-[11px] text-[var(--muted)] leading-tight">
              {user.name} · {user.role}
            </div>
          </div>
        </div>
        <nav className="flex-1 p-3 space-y-1">
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className="block rounded-md px-3 py-2 text-sm text-[var(--muted)] hover:bg-black/5 hover:text-[var(--ink)]"
            >
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="p-3 border-t border-[var(--card-border)]">
          <form action={logoutAction}>
            <button className="w-full rounded-md px-3 py-2 text-left text-sm text-[var(--muted)] hover:bg-black/5">
              Sign out
            </button>
          </form>
          <p className="px-3 pb-1 text-[10px] text-[var(--muted)]">powered by AMOS</p>
        </div>
      </aside>
      <main className="flex-1 overflow-y-auto">{children}</main>
    </div>
  );
}
