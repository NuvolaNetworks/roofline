import { getDb, STAGES } from "@/lib/db";
import { requireOrgIdentity, repScopeClause } from "@/lib/api-guard";

/** GET /api/pipeline — the org's job count and value by stage, rep-scoped to
 *  the identity's visible users (mirrors the UI) so money isn't over-shared. */
export async function GET(req: Request) {
  const auth = await requireOrgIdentity(req);
  if ("error" in auth) return auth.error;
  const scope = await repScopeClause(auth.orgId, auth.identity);
  const rows = await getDb().all<{ stage: string; jobs: number; value_cents: number }>(
    `SELECT stage, COUNT(*) AS jobs, COALESCE(SUM(value_cents),0) AS value_cents
     FROM jobs WHERE org_id = ?${scope.sql} GROUP BY stage`,
    auth.orgId, ...scope.params,
  );
  const byStage = STAGES.map((s) => {
    const r = rows.find((x) => x.stage === s);
    return { stage: s, jobs: r?.jobs ?? 0, value_usd: (r?.value_cents ?? 0) / 100 };
  });
  return Response.json({ pipeline: byStage, org_id: auth.identity.org_id });
}
