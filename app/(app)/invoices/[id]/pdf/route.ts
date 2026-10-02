import { getDb } from "@/lib/db";
import { currentUser } from "@/lib/auth";
import { getInvoice } from "@/lib/invoices";
import { loadInvoiceModel, renderInvoicePdf } from "@/lib/invoice-doc";
import { pdfResponse } from "@/lib/http-files";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return new Response("Unauthorized", { status: 401 });
  const { id } = await params;
  const db = getDb();
  const inv = await getInvoice(db, user.org_id, Number(id));
  const m = inv ? await loadInvoiceModel(db, user.org_id, inv) : null;
  if (!inv || !m) return new Response("Not found (invoices made before proposal billing have no document)", { status: 404 });
  return pdfResponse(await renderInvoicePdf(db, user.org_id, m), `${m.number}.pdf`);
}
