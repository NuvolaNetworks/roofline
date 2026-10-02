// Sample-data PDF of a template, for checking layout while editing.
import { getDb } from "@/lib/db";
import { currentUser } from "@/lib/auth";
import { fileLoader, sampleModel } from "@/lib/proposal-data";
import { renderProposalPdf } from "@/lib/proposal-pdf";
import { pdfResponse } from "@/lib/http-files";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return new Response("Unauthorized", { status: 401 });
  const { id } = await params;
  const db = getDb();
  const row = await db.get<{ id: number; name: string; kind: string; body: string | null }>(
    "SELECT id, name, kind, body FROM templates WHERE id = ? AND org_id = ? AND kind = 'proposal'",
    Number(id), user.org_id,
  );
  if (!row) return new Response("Not found", { status: 404 });
  const model = await sampleModel(db, user.org_id, row, user);
  return pdfResponse(await renderProposalPdf(model, { loadFile: fileLoader(db, user.org_id), preview: true }), `${row.name} (sample).pdf`);
}
