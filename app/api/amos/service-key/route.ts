// Public half of Roofline's AMOS service key, served at
// /.well-known/amos-app-service-key.json (rewrite in next.config.ts). AMOS
// fetches it when the builder runs `app_service_key_register`.
import { getDb } from "@/lib/db";
import { keyDocument, serviceKey } from "@/lib/amos-link";

export const dynamic = "force-dynamic";

export async function GET() {
  const doc = keyDocument(await serviceKey(getDb()));
  return Response.json(doc, { headers: { "Cache-Control": "no-store" } });
}
