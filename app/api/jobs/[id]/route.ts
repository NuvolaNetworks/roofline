import { getDb } from "@/lib/db";
import { requireIdentity } from "@/lib/api-guard";

/** GET /api/jobs/{id} — the full job file: details, timeline, measurements. */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireIdentity(req);
  if ("error" in auth) return auth.error;
  const { id } = await params;
  const db = getDb();
  const job = db
    .prepare(
      `SELECT j.*, u.name AS assignee, c.name AS contact, c.phone, c.email AS contact_email
       FROM jobs j LEFT JOIN users u ON u.id = j.assignee_id
       LEFT JOIN contacts c ON c.id = j.contact_id WHERE j.id = ?`,
    )
    .get(Number(id));
  if (!job) return Response.json({ error: "job not found" }, { status: 404 });
  return Response.json({
    job,
    events: db
      .prepare("SELECT kind, body, actor, created_at FROM job_events WHERE job_id = ? ORDER BY id DESC")
      .all(Number(id)),
    measurements: db
      .prepare("SELECT * FROM measurements WHERE job_id = ? ORDER BY id DESC")
      .all(Number(id)),
  });
}
