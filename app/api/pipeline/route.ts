import { getDb, STAGES } from "@/lib/db";
import { requireIdentity } from "@/lib/api-guard";

/** GET /api/pipeline — count and value by stage. */
export async function GET(req: Request) {
  const auth = await requireIdentity(req);
  if ("error" in auth) return auth.error;
  const rows = getDb()
    .prepare("SELECT stage, COUNT(*) AS jobs, COALESCE(SUM(value_cents),0) AS value_cents FROM jobs GROUP BY stage")
    .all() as Array<{ stage: string; jobs: number; value_cents: number }>;
  const byStage = STAGES.map((s) => {
    const r = rows.find((x) => x.stage === s);
    return { stage: s, jobs: r?.jobs ?? 0, value_usd: (r?.value_cents ?? 0) / 100 };
  });
  return Response.json({ pipeline: byStage, org_id: auth.identity.org_id });
}
