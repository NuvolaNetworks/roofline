import { getDb } from "@/lib/db";
import { sessionForToken } from "@/lib/esign";
import { getFile } from "@/lib/files";
import { fileResponse } from "@/lib/http-files";
import { snapshotFileIds } from "../../files";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ token: string; fileId: string }> }) {
  const { token, fileId } = await params;
  const db = getDb();
  const s = await sessionForToken(db, token);
  const id = Number(fileId);
  if (!s || !snapshotFileIds(s.model).has(id)) return new Response("Not found", { status: 404 });
  const f = await getFile(db, s.orgId, id);
  if (!f) return new Response("Not found", { status: 404 });
  return fileResponse(f);
}
