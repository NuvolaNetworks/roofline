export const usd = (cents: number) =>
  (cents / 100).toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });

export const usd2 = (cents: number) =>
  (cents / 100).toLocaleString(undefined, { style: "currency", currency: "USD" });

/** Whole days since an ISO-ish timestamp — stage aging on the board. */
export function daysSince(ts: string | null | undefined): number {
  if (!ts) return 0;
  const t = Date.parse(ts.replace(" ", "T") + (ts.includes("Z") ? "" : "Z"));
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.floor((Date.now() - t) / 86_400_000));
}

const TONE: Record<string, string> = {
  Draft: "bg-black/5 text-[var(--muted)]",
  Sent: "bg-blue-100 text-blue-800",
  Viewed: "bg-violet-100 text-violet-800",
  Signed: "bg-emerald-100 text-emerald-800",
  Paid: "bg-emerald-100 text-emerald-800",
  Accepted: "bg-emerald-100 text-emerald-800",
  Complete: "bg-emerald-100 text-emerald-800",
  Delivered: "bg-emerald-100 text-emerald-800",
  Ordered: "bg-blue-100 text-blue-800",
  "Pending approval": "bg-amber-100 text-amber-800",
  Overdue: "bg-red-100 text-red-800",
  Declined: "bg-red-100 text-red-800",
};

export const tone = (status: string) => TONE[status] ?? "bg-black/5 text-[var(--muted)]";
