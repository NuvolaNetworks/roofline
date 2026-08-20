import { getDb } from "@/lib/db";
import { requireOrgIdentity, repScopeClause } from "@/lib/api-guard";

/** GET /api/jobs/{id} — the full job file: details, timeline, measurements.
 *  Rep-scoped like the UI: a job outside the identity's visible users reads as
 *  not found. */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireOrgIdentity(req);
  if ("error" in auth) return auth.error;
  const { id } = await params;
  const db = getDb();
  const scope = await repScopeClause(auth.orgId, auth.identity, "j.assignee_id");
  const job = await db.get(
    `SELECT j.*, u.name AS assignee, c.name AS contact, c.phone, c.email AS contact_email
     FROM jobs j LEFT JOIN users u ON u.id = j.assignee_id
     LEFT JOIN contacts c ON c.id = j.contact_id
     WHERE j.id = ? AND j.org_id = ?${scope.sql}`,
    Number(id), auth.orgId, ...scope.params,
  );
  if (!job) return Response.json({ error: "job not found" }, { status: 404 });
  return Response.json({
    job,
    events: await db.all(
      "SELECT kind, body, actor, created_at FROM job_events WHERE job_id = ? AND org_id = ? ORDER BY id DESC",
      Number(id), auth.orgId,
    ),
    measurements: await db.all(
      "SELECT * FROM measurements WHERE job_id = ? AND org_id = ? ORDER BY id DESC",
      Number(id), auth.orgId,
    ),
  });
}
