import { getDb } from "@/lib/db";
import { requireOrgIdentity } from "@/lib/api-guard";

/** GET /api/jobs?stage=Approved — the org's jobs, optionally by stage. */
export async function GET(req: Request) {
  const auth = await requireOrgIdentity(req);
  if ("error" in auth) return auth.error;
  const stage = new URL(req.url).searchParams.get("stage");
  const db = getDb();
  const rows = stage
    ? await db.all(
        `SELECT j.id, j.title, j.address, j.trade, j.stage, j.value_cents, j.scheduled_for,
                u.name AS assignee, c.name AS contact
         FROM jobs j LEFT JOIN users u ON u.id = j.assignee_id
         LEFT JOIN contacts c ON c.id = j.contact_id
         WHERE j.org_id = ? AND j.stage = ? ORDER BY j.updated_at DESC`,
        auth.orgId, stage,
      )
    : await db.all(
        `SELECT j.id, j.title, j.address, j.trade, j.stage, j.value_cents, j.scheduled_for,
                u.name AS assignee, c.name AS contact
         FROM jobs j LEFT JOIN users u ON u.id = j.assignee_id
         LEFT JOIN contacts c ON c.id = j.contact_id
         WHERE j.org_id = ? ORDER BY j.updated_at DESC`,
        auth.orgId,
      );
  return Response.json({ jobs: rows, org_id: auth.identity.org_id });
}
