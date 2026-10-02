import type { Metadata } from "next";
import { getDb } from "@/lib/db";
import { invoiceForToken, recordInvoiceView } from "@/lib/invoices";
import { loadInvoiceModel } from "@/lib/invoice-doc";
import InvoiceDocument from "@/components/InvoiceDocument";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Invoice", referrer: "no-referrer", robots: { index: false, follow: false } };

export default async function PublicInvoice({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const db = getDb();
  const inv = await invoiceForToken(db, token);
  const m = inv ? await loadInvoiceModel(db, inv.org_id, inv) : null;
  if (!inv || !m) {
    return (
      <div className="flex min-h-screen items-center justify-center p-6">
        <div className="max-w-md rounded-2xl border border-[var(--card-border)] bg-white p-8 text-center shadow-sm">
          <h1 className="text-lg font-semibold">This invoice link isn&apos;t active</h1>
          <p className="mt-2 text-sm text-[var(--muted)]">It may have expired or been replaced. Please contact your representative for a new link.</p>
        </div>
      </div>
    );
  }
  await recordInvoiceView(db, inv);
  const enc = encodeURIComponent(token);
  return (
    <div className="min-h-screen bg-neutral-200 px-3 py-6">
      <div className="mx-auto mb-4 flex max-w-[816px] items-center justify-between">
        <span className="text-sm font-semibold">{m.branding.company_name}</span>
        <a href={`/invoice/${enc}/pdf`} className="rounded-lg border border-neutral-300 bg-white px-3 py-1.5 text-sm hover:bg-black/5">Download PDF</a>
      </div>
      <InvoiceDocument m={m} logoSrc={m.logo ? `/invoice/${enc}/pdf?logo=1` : null} />
    </div>
  );
}
