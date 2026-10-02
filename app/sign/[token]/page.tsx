import type { Metadata } from "next";
import { getDb } from "@/lib/db";
import { ACTIVE, CONSENT_TEXT, recordView, sessionForToken } from "@/lib/esign";
import { getFile } from "@/lib/files";
import { dataUrl } from "@/lib/http-files";
import { declineSignature, submitSignature } from "@/lib/sign-actions";
import { clientInfo } from "@/lib/client-info";
import ProposalDocument, { type SignatureView } from "@/components/ProposalDocument";
import SignaturePad from "@/components/SignaturePad";
import { money } from "@/lib/proposal-model";

export const dynamic = "force-dynamic";

// The URL carries the signing credential: keep it out of Referer headers
// and search indexes.
export const metadata: Metadata = {
  title: "Review and sign",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

function displayDate(ts: string | null): string {
  if (!ts) return "";
  const [y, m, d] = ts.slice(0, 10).split("-");
  return `${m}/${d}/${y}`;
}

export default async function SignPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ error?: string; signed?: string; declined?: string }>;
}) {
  const { token } = await params;
  const q = await searchParams;
  const db = getDb();
  const session = await sessionForToken(db, token);

  if (!session) {
    return (
      <div className="flex min-h-screen items-center justify-center p-6">
        <div className="max-w-md rounded-2xl border border-[var(--card-border)] bg-white p-8 text-center shadow-sm">
          <h1 className="text-lg font-semibold">This link isn&apos;t active</h1>
          <p className="mt-2 text-sm text-[var(--muted)]">
            It may have expired, been replaced with a newer link, or the document was withdrawn. Please contact
            your representative for a new link.
          </p>
        </div>
      </div>
    );
  }

  await recordView(db, session, await clientInfo());
  const { model, envelope, signer, signers } = session;
  const accent = model.branding.accent;
  const enc = encodeURIComponent(token);

  const signatures: Partial<Record<"customer" | "contractor", SignatureView>> = {};
  for (const s of signers) {
    if (s.status !== "Signed" || !s.signature_file_id) continue;
    const f = await getFile(db, session.orgId, Number(s.signature_file_id));
    if (f) signatures[s.role] = { src: dataUrl(f), date: displayDate(s.signed_at) };
  }

  const active = envelope.status === ACTIVE;
  const canSign = active && signer.status !== "Signed" && signer.status !== "Declined";
  const contractor = signers.find((s) => s.role === "contractor");
  const sign = submitSignature.bind(null, token);
  const decline = declineSignature.bind(null, token);

  let banner: React.ReactNode = null;
  if (envelope.status === "Completed") {
    banner = <>Signed by all parties. <a className="font-semibold underline" href={`/sign/${enc}/pdf`}>Download your signed copy</a>.</>;
  } else if (envelope.status === "Declined" || signer.status === "Declined") {
    banner = <>You declined this proposal. {model.rep.name ? `${model.rep.name} has been notified.` : ""}</>;
  } else if (signer.status === "Signed") {
    banner = <>Thanks — you signed this proposal.{contractor && contractor.status !== "Signed" ? ` We'll send the fully signed copy once ${model.rep.company || "the contractor"} countersigns.` : ""}</>;
  }

  return (
    <div className="min-h-screen bg-neutral-200">
      <header className="sticky top-0 z-10 border-b border-black/10 bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-[816px] items-center justify-between gap-3 px-4 py-3">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">{model.branding.company_name}</div>
            <div className="truncate text-xs text-neutral-500">
              {model.proposal.name} · {money(model.total_cents)}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <a href={`/sign/${enc}/pdf`} className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm hover:bg-black/5">
              PDF
            </a>
            {canSign ? (
              <a href="#sign" className="rounded-lg px-3 py-1.5 text-sm font-medium text-white" style={{ background: accent }}>
                Review &amp; sign
              </a>
            ) : null}
          </div>
        </div>
      </header>

      <main className="px-3 py-6">
        {banner || q.signed || q.declined ? (
          <div className="mx-auto mb-4 max-w-[816px] rounded-lg border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
            {banner}
          </div>
        ) : null}
        {q.error ? (
          <div className="mx-auto mb-4 max-w-[816px] rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900">
            {q.error}
          </div>
        ) : null}

        <ProposalDocument
          model={model}
          signatures={signatures}
          logoSrc={model.logo ? `/sign/${enc}/file/${model.logo.file_id}` : null}
          attachmentHref={(id) => `/sign/${enc}/file/${id}`}
        />

        {canSign ? (
          <section id="sign" className="mx-auto mb-10 max-w-[816px] rounded-lg bg-white p-6 shadow-md">
            <h2 className="text-lg font-semibold">Sign this proposal</h2>
            <p className="mb-4 text-sm text-neutral-600">
              Signing as <strong>{signer.name}</strong>. Total {money(model.total_cents)}.
            </p>
            <form action={sign} className="space-y-4">
              <SignaturePad defaultName={signer.name} accent={accent} />
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" name="consent" value="yes" required className="mt-1" />
                <span>{CONSENT_TEXT}</span>
              </label>
              <button className="w-full rounded-lg px-4 py-3 text-sm font-semibold text-white sm:w-auto" style={{ background: accent }}>
                Sign proposal
              </button>
            </form>
            <details className="mt-6 text-sm">
              <summary className="cursor-pointer text-neutral-500">Decline this proposal</summary>
              <form action={decline} className="mt-3 space-y-2">
                <textarea
                  name="reason"
                  rows={3}
                  maxLength={1000}
                  placeholder="Optional: let us know why"
                  className="w-full rounded-lg border border-neutral-300 px-3 py-2"
                />
                <button className="rounded-lg border border-red-300 px-3 py-1.5 text-red-700 hover:bg-red-50">Decline</button>
              </form>
            </details>
          </section>
        ) : null}
        <p className="pb-8 text-center text-[11px] text-neutral-500">
          Secured e-signature · document fingerprint {envelope.snapshot_sha256.slice(0, 16)}…
        </p>
      </main>
    </div>
  );
}
