import { getDb, type SqlValue } from "@/lib/db";
import { requireOrgIdentity, repScopeClause } from "@/lib/api-guard";

/** GET /api/jobs?stage=Approved — the org's jobs, optionally by stage.
 *  Rep-scoped to the identity's visible users, mirroring the UI. */
export async function GET(req: Request) {
  const auth = await requireOrgIdentity(req);
  if ("error" in auth) return auth.error;
  const stage = new URL(req.url).searchParams.get("stage");
  const scope = await repScopeClause(auth.orgId, auth.identity, "j.assignee_id");
  const db = getDb();
  const params: SqlValue[] = [auth.orgId];
  let where = "WHERE j.org_id = ?";
  if (stage) {
    where += " AND j.stage = ?";
    params.push(stage);
  }
  where += scope.sql;
  params.push(...scope.params);
  const rows = await db.all(
    `SELECT j.id, j.title, j.address, j.trade, j.stage, j.value_cents, j.scheduled_for,
            u.name AS assignee, c.name AS contact
     FROM jobs j LEFT JOIN users u ON u.id = j.assignee_id
     LEFT JOIN contacts c ON c.id = j.contact_id
     ${where} ORDER BY j.updated_at DESC`,
    ...params,
  );
  return Response.json({ jobs: rows, org_id: auth.identity.org_id });
}
