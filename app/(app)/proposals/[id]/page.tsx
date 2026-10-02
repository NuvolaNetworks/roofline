import Link from "next/link";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { getDb } from "@/lib/db";
import { currentUser } from "@/lib/auth";
import { loadProposalModel } from "@/lib/proposal-data";
import { ACTIVE, CONSENT_TEXT, getSigners, latestEnvelope } from "@/lib/esign";
import { emailStatus } from "@/lib/esign-notify";
import { getFile } from "@/lib/files";
import { dataUrl } from "@/lib/http-files";
import {
  addLine,
  countersignAction,
  deleteLine,
  markSignedOnPaper,
  moveLine,
  reissueLink,
  sendForSignature,
  updateLine,
  updateProposalMeta,
  voidSignature,
} from "@/lib/proposal-actions";
import { usd, usd2, tone } from "@/lib/fmt";
import type { RenderModel } from "@/lib/proposal-model";
import ProposalDocument, { type SignatureView } from "@/components/ProposalDocument";
import SignaturePad from "@/components/SignaturePad";
import CopyButton from "@/components/CopyButton";
import InvoicesPanel from "@/components/InvoicesPanel";

export const dynamic = "force-dynamic";

const input = "rounded-md border border-[var(--card-border)] bg-white px-2 py-1 text-sm";
const btn = "rounded-lg border border-[var(--card-border)] px-3 py-1.5 text-sm hover:bg-black/5 disabled:opacity-40";
const primary = "rounded-lg bg-[var(--accent)] px-3 py-1.5 text-sm text-white hover:bg-[var(--accent-light)] disabled:opacity-40";

function displayDate(ts: string | null): string {
  if (!ts) return "";
  const [y, m, d] = ts.slice(0, 10).split("-");
  return `${m}/${d}/${y}`;
}

export default async function Proposal({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ link?: string; error?: string; invoice_link?: string; invoice_id?: string; invoice_error?: string }>;
}) {
  const user = await currentUser();
  if (!user) redirect("/login");
  const { id } = await params;
  const q = await searchParams;
  const pid = Number(id);
  const db = getDb();
  const loaded = await loadProposalModel(db, user.org_id, pid, user);
  if (!loaded) notFound();
  const { proposal: p, lines, model } = loaded;

  const env = await latestEnvelope(db, user.org_id, pid);
  const signers = env ? await getSigners(db, user.org_id, Number(env.id)) : [];
  const active = env?.status === ACTIVE;
  const editable = !active && p.status !== "Signed";
  const contractor = signers.find((s) => s.role === "contractor");
  const iCountersign = active && contractor && Number(contractor.user_id) === user.id && contractor.status !== "Signed";
  const customerPending = signers.some((s) => s.role === "customer" && s.status !== "Signed");
  const emails = env ? await emailStatus(db, user.org_id, Number(env.id)) : [];
  const EMAIL_LABEL: Record<string, string> = {
    "proposal.signature_request": "Signing link",
    "proposal.countersign_request": "Countersign reminder",
    "proposal.signed_copy": "Signed copy to customer",
    "proposal.completed": "Signed notice to rep",
    "proposal.declined": "Declined notice to rep",
  };
  const emailState = (s: string, attempts: number) =>
    s === "delivered" ? "Sent" : s === "dead" ? "Failed" : attempts > 0 ? "Retrying" : "Sending";

  const templates = await db.all<{ id: number; name: string }>(
    "SELECT id, name FROM templates WHERE org_id = ? AND kind = 'proposal' ORDER BY id",
    user.org_id,
  );
  const catalogue = await db.all<{ sku: string; name: string; unit: string; price_cents: number }>(
    "SELECT sku, name, unit, price_cents FROM catalogue WHERE org_id = ? ORDER BY name",
    user.org_id,
  );

  // What the document shows: the frozen envelope while one stands (with
  // any signatures so far), otherwise the live draft.
  const frozen = env && env.status !== "Voided";
  const shown: RenderModel = frozen ? JSON.parse(env.snapshot) : model;
  const signatures: Partial<Record<"customer" | "contractor", SignatureView>> = {};
  if (frozen) {
    for (const s of signers) {
      if (s.status !== "Signed" || !s.signature_file_id) continue;
      const f = await getFile(db, user.org_id, Number(s.signature_file_id));
      if (f) signatures[s.role] = { src: dataUrl(f), date: displayDate(s.signed_at) };
    }
  }

  const h = await headers();
  const origin = `${h.get("x-forwarded-proto") ?? "http"}://${h.get("x-forwarded-host") ?? h.get("host")}`;
  const link = q.link ? `${origin}/sign/${encodeURIComponent(q.link)}` : null;
  const customerEmail = model.customer.email;
  const mailto = link
    ? `mailto:${encodeURIComponent(customerEmail)}?subject=${encodeURIComponent(`Your proposal from ${model.branding.company_name}`)}&body=${encodeURIComponent(
        `Hi ${model.customer.name},\n\nYour proposal for ${model.customer.address} is ready to review and sign:\n\n${link}\n\nThank you,\n${user.name}\n${model.branding.company_name}`,
      )}`
    : null;

  const total = lines.reduce((s, l) => s + Math.round(Number(l.qty) * Number(l.unit_price_cents)), 0);
  const cost = lines.reduce((s, l) => s + Math.round(Number(l.qty) * Number(l.unit_cost_cents)), 0);
  const pdfHref = frozen ? `/proposals/${pid}/pdf?envelope=${env.id}` : `/proposals/${pid}/pdf`;

  return (
    <div className="max-w-5xl p-6">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{p.name}</h1>
          <p className="text-sm text-[var(--muted)]">
            <Link href={`/jobs/${p.job_id}`} className="text-[var(--accent-light)] hover:underline">{p.job_title}</Link>
            {" "}· {model.customer.name || "no customer"} · {p.address}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className={`rounded-full px-2 py-0.5 text-xs ${tone(p.status)}`}>{p.status}</span>
          <a href={pdfHref} target="_blank" rel="noreferrer" className={btn}>Open PDF</a>
        </div>
      </div>

      {q.error ? (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-800">{q.error}</div>
      ) : null}

      {/* ── Signature panel ─────────────────────────────────────────── */}
      <div className="mb-6 rounded-xl border border-[var(--card-border)] bg-[var(--card)] p-4">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="font-semibold">E-signature</h2>
          {env ? (
            <span className={`rounded-full px-2 py-0.5 text-xs ${tone(env.status === "Completed" ? "Signed" : active ? "Sent" : env.status)}`}>
              {env.status}
            </span>
          ) : null}
        </div>

        {link ? (
          <div className="mb-3 rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm">
            <div className="mb-1 font-medium">Signing link for {model.customer.name}</div>
            <div className="mb-2 break-all font-mono text-xs">{link}</div>
            <div className="flex flex-wrap gap-2">
              <CopyButton value={link} />
              {mailto ? <a href={mailto} className={btn}>Email it{customerEmail ? ` to ${customerEmail}` : ""}</a> : null}
            </div>
            <p className="mt-2 text-xs text-[var(--muted)]">
              {customerEmail
                ? `Roofline is emailing this link to ${customerEmail} from ${model.branding.company_name || "your company"} — status below. `
                : "No customer email on file, so send this link yourself. "}
              Shown once — Roofline keeps only a fingerprint of it. Lost it? Issue a new link (the old one stops working).
            </p>
          </div>
        ) : null}

        {frozen && signers.length ? (
          <ul className="mb-3 space-y-1 text-sm">
            {signers.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--card-border)] py-1.5 last:border-0">
                <span>
                  {s.name}{" "}
                  <span className="text-xs text-[var(--muted)]">({s.role === "customer" ? "customer, signs by link" : "countersigns in Roofline"})</span>
                </span>
                <span className="text-xs text-[var(--muted)]">
                  <span className={`mr-2 rounded-full px-2 py-0.5 ${tone(s.status)}`}>{s.status}</span>
                  {s.signed_at ? `signed ${s.signed_at} UTC` : s.viewed_at ? `viewed ${s.viewed_at} UTC` : ""}
                  {s.decline_reason ? ` — “${s.decline_reason}”` : ""}
                </span>
              </li>
            ))}
          </ul>
        ) : null}

        {frozen && emails.length ? (
          <ul className="mb-3 space-y-1 text-xs">
            {emails.map((e, i) => (
              <li key={i} className="flex flex-wrap items-center justify-between gap-2">
                <span>{EMAIL_LABEL[e.topic] ?? e.topic} email</span>
                <span className="text-[var(--muted)]">
                  <span className={`mr-2 rounded-full px-2 py-0.5 ${tone(emailState(e.status, Number(e.attempts)) === "Sent" ? "Signed" : emailState(e.status, Number(e.attempts)) === "Failed" ? "Declined" : "Sent")}`}>
                    {emailState(e.status, Number(e.attempts))}
                  </span>
                  {e.delivered_at ? `${e.delivered_at} UTC` : e.last_error ? e.last_error.slice(0, 80) : ""}
                </span>
              </li>
            ))}
          </ul>
        ) : null}

        {env?.status === "Completed" ? (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <a href={`/proposals/${pid}/pdf?envelope=${env.id}&download=1`} className={primary}>Download signed PDF</a>
            <span className="text-xs text-[var(--muted)]">SHA-256 {env.final_sha256?.slice(0, 24)}… · filed on the job</span>
          </div>
        ) : null}

        {iCountersign ? (
          <form action={countersignAction.bind(null, pid)} className="mt-2 space-y-3 rounded-lg border border-[var(--card-border)] p-3">
            <div className="text-sm font-medium">Your countersignature</div>
            <SignaturePad defaultName={user.name} />
            <label className="flex items-start gap-2 text-xs">
              <input type="checkbox" name="consent" value="yes" required className="mt-0.5" />
              <span>{CONSENT_TEXT}</span>
            </label>
            <button className={primary}>Countersign</button>
          </form>
        ) : active && contractor && contractor.status !== "Signed" ? (
          <p className="text-xs text-[var(--muted)]">Waiting on {contractor.name} to countersign from their Roofline login.</p>
        ) : null}

        {active ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {customerPending ? (
              <form action={reissueLink.bind(null, pid)}>
                <button className={btn}>Issue a new customer link</button>
              </form>
            ) : null}
            <form action={voidSignature.bind(null, pid)} className="flex gap-2">
              <input name="reason" placeholder="Reason (optional)" className={input} />
              <button className={btn}>Void &amp; edit</button>
            </form>
          </div>
        ) : null}

        {editable ? (
          <div className="flex flex-wrap items-center gap-2">
            <form action={sendForSignature.bind(null, pid)}>
              <button className={primary} disabled={!lines.length}>Send for signature</button>
            </form>
            <form action={markSignedOnPaper.bind(null, pid)}>
              <button className={btn}>Mark signed on paper</button>
            </form>
            <span className="text-xs text-[var(--muted)]">
              {customerEmail ? `Customer: ${customerEmail}` : "No customer email on file — you can still copy the link."}
            </span>
          </div>
        ) : null}
      </div>

      {p.status === "Signed" ? (
        <div className="mb-6 rounded-xl border border-[var(--card-border)] bg-[var(--card)] p-4">
          <h2 className="mb-2 font-semibold">Invoices</h2>
          <InvoicesPanel
            orgId={user.org_id}
            jobId={p.job_id}
            proposalId={pid}
            returnTo={`/proposals/${pid}`}
            link={q.invoice_link}
            linkInvoiceId={Number(q.invoice_id) || undefined}
            error={q.invoice_error}
          />
        </div>
      ) : null}

      {/* ── Editor ──────────────────────────────────────────────────── */}
      {editable ? (
        <div className="mb-6 rounded-xl border border-[var(--card-border)] bg-[var(--card)] p-4">
          <form action={updateProposalMeta.bind(null, pid)} className="mb-4 flex flex-wrap items-end gap-2">
            <label className="flex flex-col text-xs text-[var(--muted)]">
              Name
              <input name="name" defaultValue={p.name} className={`${input} w-72`} />
            </label>
            <label className="flex flex-col text-xs text-[var(--muted)]">
              Template
              <select name="template_id" defaultValue={String(loaded.template?.id ?? "")} className={input}>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            </label>
            <button className={btn}>Save</button>
            <Link href={loaded.template ? `/templates/${loaded.template.id}` : "/templates"} className="pb-1.5 text-xs text-[var(--accent-light)] hover:underline">
              Edit template
            </Link>
          </form>

          <h2 className="mb-2 font-semibold">Line items</h2>
          <div className="space-y-2">
            {lines.map((l, i) => (
              <form
                key={l.id}
                action={updateLine.bind(null, pid, Number(l.id))}
                className="grid grid-cols-12 gap-2 rounded-lg border border-[var(--card-border)] p-2"
              >
                <input name="section" defaultValue={l.section} placeholder="Section" className={`${input} col-span-3`} />
                <input name="name" defaultValue={l.name} className={`${input} col-span-5`} />
                <input name="qty" defaultValue={String(Number(l.qty))} className={`${input} col-span-1 text-right`} aria-label="Quantity" />
                <input name="unit" defaultValue={l.unit} className={`${input} col-span-1`} aria-label="Unit" />
                <input name="price" defaultValue={(Number(l.unit_price_cents) / 100).toFixed(2)} className={`${input} col-span-2 text-right`} aria-label="Unit price" />
                <textarea
                  name="notes"
                  defaultValue={l.notes}
                  rows={Math.max(1, l.notes.split("\n").length)}
                  placeholder="Notes shown under the item (one per line)"
                  className={`${input} col-span-9`}
                />
                <div className="col-span-3 flex items-start justify-end gap-1">
                  <span className="mr-auto pt-1 text-xs tabular-nums text-[var(--muted)]">
                    {usd2(Math.round(Number(l.qty) * Number(l.unit_price_cents)))}
                  </span>
                  <button className={btn}>Save</button>
                  <button formAction={moveLine.bind(null, pid, Number(l.id), -1)} disabled={i === 0} className={btn} aria-label="Move up">↑</button>
                  <button formAction={moveLine.bind(null, pid, Number(l.id), 1)} disabled={i === lines.length - 1} className={btn} aria-label="Move down">↓</button>
                  <button formAction={deleteLine.bind(null, pid, Number(l.id))} className={`${btn} text-red-700`} aria-label="Delete line">✕</button>
                </div>
              </form>
            ))}
          </div>

          <form action={addLine.bind(null, pid)} className="mt-3 grid grid-cols-12 gap-2 rounded-lg border border-dashed border-[var(--card-border)] p-2">
            <select name="sku" defaultValue="" className={`${input} col-span-4`}>
              <option value="">Custom item…</option>
              {catalogue.map((c) => (
                <option key={c.sku} value={c.sku}>{c.name} — {usd2(Number(c.price_cents))}/{c.unit}</option>
              ))}
            </select>
            <input name="section" placeholder="Section (e.g. Roofing Accessories)" className={`${input} col-span-3`} />
            <input name="name" placeholder="Item name (custom)" className={`${input} col-span-3`} />
            <input name="qty" defaultValue="1" className={`${input} col-span-1 text-right`} aria-label="Quantity" />
            <input name="unit" placeholder="unit" className={`${input} col-span-1`} />
            <textarea name="notes" rows={1} placeholder="Notes" className={`${input} col-span-8`} />
            <input name="price" placeholder="Unit price (blank = catalog)" className={`${input} col-span-2`} />
            <button className={`${primary} col-span-2`}>Add line</button>
          </form>
          <p className="mt-3 text-xs text-[var(--muted)]">
            Total {usd2(total)} · cost {usd(cost)} · margin {usd(total - cost)}
            {total > 0 ? ` (${Math.round(((total - cost) / total) * 100)}%)` : ""}
          </p>
        </div>
      ) : null}

      {/* ── Document ────────────────────────────────────────────────── */}
      <h2 className="mb-2 font-semibold">{editable ? "Preview" : "Document"}</h2>
      <div className="rounded-xl bg-neutral-200 p-4">
        <ProposalDocument
          model={shown}
          signatures={signatures}
          logoSrc={shown.logo ? `/files/${shown.logo.file_id}` : null}
          attachmentHref={(fid) => `/files/${fid}`}
        />
      </div>
    </div>
  );
}
