import { submitInstantEstimate } from "@/lib/actions";

/** Public — no session. This is the QR/website lead capture. The target org
 *  rides in the QR link (?org=<org uuid>); in demo mode it may be omitted and
 *  submissions land in the demo org. */
export default async function EstimateForm({
  searchParams,
}: {
  searchParams: Promise<{ org?: string; error?: string }>;
}) {
  const { org = "", error } = await searchParams;
  const input = "w-full rounded-lg border border-[var(--card-border)] px-3 py-2 text-sm";
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-md rounded-2xl border border-[var(--card-border)] bg-[var(--card)] p-8 shadow-sm">
        <h1 className="text-xl font-semibold">Get an instant roof estimate</h1>
        <p className="mb-5 mt-1 text-sm text-[var(--muted)]">
          Enter your address and we&apos;ll size your roof from aerial imagery — no visit required. A specialist
          follows up with an exact quote.
        </p>
        {error ? (
          <p className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
            {error === "org"
              ? "This estimate link is incomplete — please use the QR code or link your roofer shared."
              : "Please give us your name and the property address."}
          </p>
        ) : null}
        <form action={submitInstantEstimate} className="space-y-3">
          <input type="hidden" name="org" value={org} />
          <input name="name" required placeholder="Your name" className={input} />
          <input name="address" required placeholder="Property address" className={input} />
          <div className="flex gap-3">
            <input name="phone" placeholder="Phone" className={input} />
            <input name="email" placeholder="Email" className={input} />
          </div>
          <select name="trade" className={input}>
            {["Roofing", "Gutters", "Carpentry", "Remodel"].map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
          <button className="w-full rounded-lg bg-[var(--accent)] py-2 text-sm font-medium text-white hover:bg-[var(--accent-light)]">
            Get my estimate
          </button>
        </form>
        <p className="mt-4 text-xs text-[var(--muted)]">Powered by Roofline on AMOS.</p>
      </div>
    </div>
  );
}
