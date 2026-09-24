import { redirect } from "next/navigation";
import { getDb } from "@/lib/db";
import { currentUser } from "@/lib/auth";
import { daysSince } from "@/lib/fmt";

export const dynamic = "force-dynamic";

export default async function InstantEstimatorAdmin() {
  const user = await currentUser();
  if (!user) redirect("/login");
  const leads = await getDb().all(
    `SELECT j.id, j.title, j.address, j.created_at, c.name AS contact, m.total_squares
     FROM jobs j LEFT JOIN contacts c ON c.id = j.contact_id
     LEFT JOIN measurements m ON m.job_id = j.id AND m.provider = 'solar_estimate'
     WHERE j.org_id = ? AND j.source = 'QR instant estimate' ORDER BY j.id DESC`,
    user.org_id,
  );
  // A revocable estimator TOKEN rides in the QR link (never the org PK), so
  // public submissions land in THIS org without exposing an enumerable id (H1).
  const org = await getDb().get<{ estimator_token: string | null }>(
    "SELECT estimator_token FROM orgs WHERE id = ?",
    user.org_id,
  );
  const token = org?.estimator_token ?? "";
  const url = `https://roofline.custom.amoslabs.com/estimate/form?token=${encodeURIComponent(token)}`;
  const qr = `https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=${encodeURIComponent(url)}`;
  return (
    <div className="max-w-3xl p-6">
      <h1 className="mb-1 text-xl font-semibold">Instant Estimator</h1>
      <p className="mb-4 text-sm text-[var(--muted)]">
        Put the QR on a yard sign, truck or business card. A homeowner scans it, enters their address, and gets an
        instant rough number from Google&apos;s Solar API — while you get a lead with a measurement already attached.
        The contract-grade report is ordered when a rep takes the job.
      </p>
      <div className="mb-6 flex flex-wrap items-center gap-6 rounded-xl border border-[var(--card-border)] bg-[var(--card)] p-4">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={qr} alt="Instant Estimator QR code" width={160} height={160} />
        <div>
          <div className="text-sm font-medium">Public estimate page</div>
          <a
            href={`/estimate/form?token=${encodeURIComponent(token)}`}
            className="break-all text-sm text-[var(--accent-light)] hover:underline"
          >
            {url}
          </a>
          <p className="mt-2 max-w-sm text-xs text-[var(--muted)]">
            No login required for homeowners. Submissions land in <b>New lead</b> and round-robin to a rep.
          </p>
        </div>
      </div>
      <h2 className="mb-2 font-semibold">Leads from the estimator</h2>
      <div className="rounded-xl border border-[var(--card-border)] bg-[var(--card)]">
        {leads.map((l) => (
          <a key={String(l.id)} href={`/jobs/${l.id}`} className="flex items-center justify-between border-b border-[var(--card-border)] p-3 text-sm last:border-0 hover:bg-black/5">
            <span>
              {String(l.contact)} — {String(l.address)}
            </span>
            <span className="text-xs text-[var(--muted)]">
              {l.total_squares ? `~${Number(l.total_squares)} sq · ` : ""}
              {daysSince(String(l.created_at))}d ago
            </span>
          </a>
        ))}
        {leads.length === 0 ? <div className="p-4 text-sm text-[var(--muted)]">No scans yet.</div> : null}
      </div>
    </div>
  );
}
