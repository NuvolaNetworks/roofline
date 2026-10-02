// Authenticated file download, fenced to the session user's org.
import { getDb } from "@/lib/db";
import { currentUser } from "@/lib/auth";
import { getFile } from "@/lib/files";
import { fileResponse } from "@/lib/http-files";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return new Response("Unauthorized", { status: 401 });
  const { id } = await params;
  const f = await getFile(getDb(), user.org_id, Number(id));
  if (!f) return new Response("Not found", { status: 404 });
  return fileResponse(f, new URL(req.url).searchParams.get("download") === "1");
}
