import { loginAction } from "@/lib/actions";
import { amosLoginUrl } from "@/lib/amos-identity";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
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
            Wrong email or password.
          </p>
        ) : null}
        <a
          href={amosLoginUrl()}
          className="block w-full rounded-lg bg-[var(--accent)] py-2 text-center text-sm font-medium text-white hover:bg-[var(--accent-light)]"
        >
          Sign in with AMOS
        </a>
        <p className="my-4 text-center text-xs text-[var(--muted)]">Your company account, one password, managed by AMOS.</p>
        <details className="text-xs text-[var(--muted)]">
          <summary className="cursor-pointer">Demo sign-in</summary>
        <form action={loginAction} className="mt-3 space-y-3">
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
          <button className="w-full rounded-lg border border-[var(--card-border)] py-2 text-sm font-medium hover:bg-[var(--card-border)]">
            Sign in to the demo
          </button>
        </form>
        </details>
        <p className="mt-6 text-xs text-[var(--muted)]">
          Demo accounts (password <code>demo2026</code>): jeff@demo.roofline
          (admin) · dana@demo.roofline (manager) · marcus@demo.roofline (rep)
        </p>
      </div>
    </div>
  );
}
