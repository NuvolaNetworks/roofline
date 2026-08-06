export default async function Thanks({ searchParams }: { searchParams: Promise<{ sq?: string }> }) {
  const { sq } = await searchParams;
  const squares = Number(sq ?? 0);
  const low = Math.round((squares * 42000) / 100) * 100;
  const high = Math.round((squares * 61000) / 100) * 100;
  const fmt = (n: number) => `$${n.toLocaleString()}`;
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-md rounded-2xl border border-[var(--card-border)] bg-[var(--card)] p-8 text-center shadow-sm">
        <h1 className="text-xl font-semibold">Your instant estimate</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">Based on aerial imagery of your roof</p>
        <div className="my-6">
          <div className="text-3xl font-semibold">
            {fmt(low)} – {fmt(high)}
          </div>
          <div className="mt-1 text-sm text-[var(--muted)]">approx. {squares} squares</div>
        </div>
        <p className="text-sm text-[var(--muted)]">
          A specialist will confirm with a precise measurement report and a firm quote — usually the same day.
        </p>
      </div>
    </div>
  );
}
