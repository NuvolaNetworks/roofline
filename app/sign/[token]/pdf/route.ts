import { getDb } from "@/lib/db";
import { envelopePdf, sessionForToken } from "@/lib/esign";
import { pdfResponse } from "@/lib/http-files";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const db = getDb();
  const s = await sessionForToken(db, token);
  if (!s) return new Response("This link is invalid or has expired.", { status: 404 });
  const pdf = await envelopePdf(db, s.orgId, s.envelope);
  const signed = s.envelope.status === "Completed";
  return pdfResponse(pdf, `${s.model.proposal.name}${signed ? " - signed" : ""}.pdf`);
}
