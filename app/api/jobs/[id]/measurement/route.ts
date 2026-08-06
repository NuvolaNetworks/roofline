import { getDb } from "@/lib/db";
import { requireIdentity } from "@/lib/api-guard";

/** POST /api/jobs/{id}/measurement — order a roof measurement report.
 *  Stubbed provider call: the real integration is an AMOS connection whose
 *  operation contract classifies the order as a write. */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireIdentity(req);
  if ("error" in auth) return auth.error;
  const { id } = await params;
  const db = getDb();
  const exists = db.prepare("SELECT id FROM jobs WHERE id = ?").get(Number(id));
  if (!exists) return Response.json({ error: "job not found" }, { status: 404 });
  db.prepare(
    `INSERT INTO measurements (job_id, provider, status, total_squares, ridge_ft, hip_ft, valley_ft, eave_ft, rake_ft, pitch)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(Number(id), "gaf_quickmeasure", "delivered", 30.6, 58, 24, 37, 141, 92, "6/12");
  db.prepare("INSERT INTO job_events (job_id, kind, body, actor) VALUES (?,?,?,?)").run(
    Number(id),
    "system",
    "GAF QuickMeasure report ordered and delivered",
    auth.identity.email,
  );
  return Response.json({
    job_id: Number(id),
    provider: "gaf_quickmeasure",
    status: "delivered",
    total_squares: 30.6,
    pitch: "6/12",
  });
}
