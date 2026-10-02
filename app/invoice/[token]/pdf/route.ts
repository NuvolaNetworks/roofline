import { getDb } from "@/lib/db";
import { invoiceForToken } from "@/lib/invoices";
import { loadInvoiceModel, renderInvoicePdf } from "@/lib/invoice-doc";
import { fileResponse, pdfResponse } from "@/lib/http-files";
import { getFile } from "@/lib/files";

export const dynamic = "force-dynamic";

// The homeowner's invoice PDF; `?logo=1` serves the branding logo for the
// HTML view (the only file this link may read).
export async function GET(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const db = getDb();
  const inv = await invoiceForToken(db, token);
  const m = inv ? await loadInvoiceModel(db, inv.org_id, inv) : null;
  if (!inv || !m) return new Response("This invoice link isn't active.", { status: 404 });
  if (new URL(req.url).searchParams.get("logo") === "1") {
    const f = m.logo ? await getFile(db, inv.org_id, m.logo.file_id) : null;
    return f ? fileResponse(f) : new Response("Not found", { status: 404 });
  }
  return pdfResponse(await renderInvoicePdf(db, inv.org_id, m), `${m.number}.pdf`);
}
