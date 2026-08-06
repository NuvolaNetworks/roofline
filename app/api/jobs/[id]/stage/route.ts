import { getDb, STAGES, type Stage } from "@/lib/db";
import { requireIdentity } from "@/lib/api-guard";

/** POST /api/jobs/{id}/stage — advance a job to the next pipeline stage. */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireIdentity(req);
  if ("error" in auth) return auth.error;
  const { id } = await params;
  const db = getDb();
  const job = db.prepare("SELECT stage FROM jobs WHERE id = ?").get(Number(id)) as
    | { stage: Stage }
    | undefined;
  if (!job) return Response.json({ error: "job not found" }, { status: 404 });
  const idx = STAGES.indexOf(job.stage);
  if (idx < 0 || idx >= STAGES.length - 1) {
    return Response.json({ error: `job is already at ${job.stage}` }, { status: 409 });
  }
  const next = STAGES[idx + 1];
  db.prepare("UPDATE jobs SET stage = ?, updated_at = datetime('now') WHERE id = ?").run(
    next,
    Number(id),
  );
  db.prepare("INSERT INTO job_events (job_id, kind, body, actor) VALUES (?,?,?,?)").run(
    Number(id),
    "stage",
    `Moved to ${next}`,
    auth.identity.email,
  );
  return Response.json({ id: Number(id), from: job.stage, stage: next });
}
