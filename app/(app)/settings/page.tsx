import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

const AMOS_CONNECTIONS_URL = "https://app.amoslabs.com/settings/connections";

/** Horizontal services the company connects ONCE in AMOS; every app the
 *  company runs — Roofline included — uses them through the platform. Status
 *  reflects the AMOS connection catalog, not this app. */
const PLATFORM = [
  {
    label: "QuickBooks Online",
    powers: "Invoices and payments sync when a job is invoiced",
    availability: "available",
  },
  {
    label: "Stripe",
    powers: "Deposit and balance payment links on the job file",
    availability: "available",
  },
  {
    label: "Microsoft 365 (Outlook)",
    powers: "Production calendar sync; scheduling parks for approval",
    availability: "available",
  },
  {
    label: "Twilio SMS",
    powers: "Homeowner install-day texts — every send human-approved",
    availability: "available",
  },
  {
    label: "DocuSign",
    powers: "Contracts and Certificates of Completion",
    availability: "platform setup required",
  },
  {
    label: "Google Calendar",
    powers: "Alternative to Outlook for production scheduling",
    availability: "not in catalog yet",
  },
] as const;

/** Roofing-specific services. These are NOT special: AMOS connects any REST
 *  API as a governed custom provider, then reviewed operation contracts
 *  (method + path + schemas + read/write consequence) become the callable
 *  surface. Same vault, same approvals, same receipts. */
const VERTICAL = [
  {
    label: "SRS Roof Hub",
    powers: "Live SKU pricing in the catalogue; material orders from proposals",
  },
  {
    label: "GAF QuickMeasure / EagleView",
    powers: "Ordered measurement reports → auto-filled proposal line items",
  },
  {
    label: "Google Solar API",
    powers: "Instant Estimator rough numbers at lead capture (not contract-grade)",
  },
] as const;

export default async function Settings() {
  const user = await currentUser();
  if (!user) redirect("/login");

  return (
    <div className="p-6 max-w-2xl">
      <h1 className="text-xl font-semibold">Integrations</h1>
      <p className="mt-1 mb-5 text-sm text-[var(--muted)]">
        Roofline holds no credentials. Every integration is connected once in
        AMOS, where the secret is encrypted in the platform vault, consequential
        calls park for human approval, and every action leaves a receipt. Connect
        a service for the whole company and every app inherits it.
      </p>

      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-[var(--muted)]">
        Connected through AMOS
      </h2>
      <div className="mb-6 space-y-2">
        {PLATFORM.map((c) => (
          <div
            key={c.label}
            className="flex items-center justify-between rounded-xl border border-[var(--card-border)] bg-[var(--card)] p-4"
          >
            <div>
              <div className="font-medium">{c.label}</div>
              <div className="text-sm text-[var(--muted)]">{c.powers}</div>
            </div>
            <span
              className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${
                c.availability === "available"
                  ? "bg-emerald-100 text-emerald-800"
                  : "bg-black/5 text-[var(--muted)]"
              }`}
            >
              {c.availability}
            </span>
          </div>
        ))}
      </div>

      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-[var(--muted)]">
        Roofing services
      </h2>
      <div className="space-y-2">
        {VERTICAL.map((c) => (
          <div
            key={c.label}
            className="rounded-xl border border-[var(--card-border)] bg-[var(--card)] p-4"
          >
            <div className="font-medium">{c.label}</div>
            <div className="text-sm text-[var(--muted)]">{c.powers}</div>
          </div>
        ))}
      </div>
      <p className="mt-3 text-xs text-[var(--muted)]">
        These are ordinary AMOS connections too: any REST API becomes a governed
        provider, and reviewed operation contracts (method, path, schemas, and
        whether the call reads or writes) define exactly what may be called.
        Reads run unattended; writes — ordering materials, charging a card —
        park for a human.
      </p>

      <a
        href={AMOS_CONNECTIONS_URL}
        className="mt-5 inline-block rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--accent-light)]"
      >
        Manage connections in AMOS →
      </a>
      {user.role === "rep" ? (
        <p className="mt-2 text-xs text-[var(--muted)]">
          Connecting services is an owner/admin action in AMOS.
        </p>
      ) : null}
    </div>
  );
}
