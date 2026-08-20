import { getDb, STAGES, type Stage } from "@/lib/db";
import { requireOrgIdentity } from "@/lib/api-guard";

/** POST /api/jobs/{id}/stage — advance a job to the next pipeline stage. */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireOrgIdentity(req);
  if ("error" in auth) return auth.error;
  const { id } = await params;
  const db = getDb();
  const job = await db.get<{ stage: Stage }>(
    "SELECT stage FROM jobs WHERE id = ? AND org_id = ?",
    Number(id), auth.orgId,
  );
  if (!job) return Response.json({ error: "job not found" }, { status: 404 });
  const idx = STAGES.indexOf(job.stage);
  if (idx < 0 || idx >= STAGES.length - 1) {
    return Response.json({ error: `job is already at ${job.stage}` }, { status: 409 });
  }
  const next = STAGES[idx + 1];
  await db.run(
    "UPDATE jobs SET stage = ?, updated_at = datetime('now') WHERE id = ? AND org_id = ?",
    next, Number(id), auth.orgId,
  );
  await db.run(
    "INSERT INTO job_events (org_id, job_id, kind, body, actor) VALUES (?,?,?,?,?)",
    auth.orgId, Number(id), "stage", `Moved to ${next}`, auth.identity.email,
  );
  return Response.json({ id: Number(id), from: job.stage, stage: next });
}
