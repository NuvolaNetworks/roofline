import { headers } from "next/headers";
import { loginAction } from "@/lib/actions";
import { authMode } from "@/lib/auth";
import { platformIdpLoginUrl } from "@/lib/amos-identity";

const ERRORS: Record<string, string> = {
  "1": "Wrong email or password.",
  amos: "AMOS sign-in failed — the identity token was missing or invalid.",
  mode: "That sign-in method isn't enabled for this deployment.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const mode = authMode();
  const hdrs = await headers();
  const host =
    hdrs.get("x-forwarded-host") ?? hdrs.get("host") ?? "roofline.custom.amoslabs.com";
  const proto = hdrs.get("x-forwarded-proto") ?? "https";
  const amosLoginUrl = platformIdpLoginUrl(`${proto}://${host}/auth/callback`);
  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="w-full max-w-sm rounded-2xl border border-[var(--card-border)] bg-[var(--card)] p-8 shadow-sm">
        <div className="mb-6">
          <div className="h-10 w-10 rounded-xl bg-[var(--accent)] text-white flex items-center justify-center font-bold text-lg">
            R
          </div>
          <h1 className="mt-4 text-xl font-semibold">Roofline</h1>
          <p className="text-sm text-[var(--muted)]">
            Jobs, proposals, production — powered by AMOS.
          </p>
        </div>
        {error ? (
          <p className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
            {ERRORS[error] ?? "Sign-in failed."}
          </p>
        ) : null}
        {mode === "amos" ? (
          <>
            <a
              href={amosLoginUrl}
              className="block w-full rounded-lg bg-[var(--accent)] py-2 text-center text-sm font-medium text-white hover:bg-[var(--accent-light)]"
            >
              Continue with AMOS
            </a>
            <p className="mt-6 text-xs text-[var(--muted)]">
              Your company&apos;s AMOS account owns sign-in — one login for every
              app the company runs. Roofline never sees your password.
            </p>
          </>
        ) : (
          <>
            <form action={loginAction} className="space-y-3">
              <input
                name="email"
                type="email"
                required
                placeholder="you@company.com"
                className="w-full rounded-lg border border-[var(--card-border)] px-3 py-2 text-sm"
              />
              <input
                name="password"
                type="password"
                required
                placeholder="Password"
                className="w-full rounded-lg border border-[var(--card-border)] px-3 py-2 text-sm"
              />
              <button className="w-full rounded-lg bg-[var(--accent)] py-2 text-sm font-medium text-white hover:bg-[var(--accent-light)]">
                Sign in
              </button>
            </form>
            <p className="mt-6 text-xs text-[var(--muted)]">
              Demo accounts (password <code>demo2026</code>): jeff@demo.roofline
              (admin) · dana@demo.roofline (manager) · marcus@demo.roofline (rep)
            </p>
          </>
        )}
      </div>
    </div>
  );
}
