import { getDb, STAGES } from "@/lib/db";
import { requireOrgIdentity } from "@/lib/api-guard";

/** GET /api/pipeline — the org's job count and value by stage. */
export async function GET(req: Request) {
  const auth = await requireOrgIdentity(req);
  if ("error" in auth) return auth.error;
  const rows = await getDb().all<{ stage: string; jobs: number; value_cents: number }>(
    "SELECT stage, COUNT(*) AS jobs, COALESCE(SUM(value_cents),0) AS value_cents FROM jobs WHERE org_id = ? GROUP BY stage",
    auth.orgId,
  );
  const byStage = STAGES.map((s) => {
    const r = rows.find((x) => x.stage === s);
    return { stage: s, jobs: r?.jobs ?? 0, value_usd: (r?.value_cents ?? 0) / 100 };
  });
  return Response.json({ pipeline: byStage, org_id: auth.identity.org_id });
}
