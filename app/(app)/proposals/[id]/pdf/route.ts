// In-app proposal PDF: the live preview (current lines + template), or —
// with ?envelope= — the frozen/signed document of that envelope.
import { getDb } from "@/lib/db";
import { currentUser } from "@/lib/auth";
import { fileLoader, loadProposalModel } from "@/lib/proposal-data";
import { renderProposalPdf } from "@/lib/proposal-pdf";
import { envelopePdf, getEnvelope } from "@/lib/esign";
import { pdfResponse } from "@/lib/http-files";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return new Response("Unauthorized", { status: 401 });
  const { id } = await params;
  const db = getDb();
  const url = new URL(req.url);
  const download = url.searchParams.get("download") === "1";
  const envelopeId = Number(url.searchParams.get("envelope"));
  if (envelopeId) {
    const env = await getEnvelope(db, user.org_id, envelopeId);
    if (!env || Number(env.proposal_id) !== Number(id)) return new Response("Not found", { status: 404 });
    const name = JSON.parse(env.snapshot).proposal?.name ?? "proposal";
    return pdfResponse(await envelopePdf(db, user.org_id, env), `${name}${env.status === "Completed" ? " - signed" : ""}.pdf`, download);
  }
  const loaded = await loadProposalModel(db, user.org_id, Number(id), user);
  if (!loaded) return new Response("Not found", { status: 404 });
  const pdf = await renderProposalPdf(loaded.model, { loadFile: fileLoader(db, user.org_id), preview: loaded.proposal.status !== "Signed" });
  return pdfResponse(pdf, `${loaded.model.proposal.name}.pdf`, download);
}
