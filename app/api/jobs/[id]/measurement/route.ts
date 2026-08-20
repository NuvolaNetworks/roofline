import { getDb } from "@/lib/db";
import { requireOrgIdentity } from "@/lib/api-guard";

/** POST /api/jobs/{id}/measurement — order a roof measurement report.
 *  Stubbed provider call: the real integration is an AMOS connection whose
 *  operation contract classifies the order as a write. */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireOrgIdentity(req);
  if ("error" in auth) return auth.error;
  const { id } = await params;
  const db = getDb();
  const exists = await db.get<{ id: number }>(
    "SELECT id FROM jobs WHERE id = ? AND org_id = ?",
    Number(id), auth.orgId,
  );
  if (!exists) return Response.json({ error: "job not found" }, { status: 404 });
  await db.run(
    `INSERT INTO measurements (org_id, job_id, provider, status, total_squares, ridge_ft, hip_ft, valley_ft, eave_ft, rake_ft, pitch)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    auth.orgId, Number(id), "gaf_quickmeasure", "delivered", 30.6, 58, 24, 37, 141, 92, "6/12",
  );
  await db.run(
    "INSERT INTO job_events (org_id, job_id, kind, body, actor) VALUES (?,?,?,?,?)",
    auth.orgId, Number(id), "system", "GAF QuickMeasure report ordered and delivered", auth.identity.email,
  );
  return Response.json({
    job_id: Number(id),
    provider: "gaf_quickmeasure",
    status: "delivered",
    total_squares: 30.6,
    pitch: "6/12",
  });
}
