import { getDb } from "@/lib/db";
import { requireOrgIdentity } from "@/lib/api-guard";

/** POST /api/leads — capture a new lead and open its job file. */
export async function POST(req: Request) {
  const auth = await requireOrgIdentity(req);
  if ("error" in auth) return auth.error;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const name = String(body.name ?? "").trim();
  const address = String(body.address ?? "").trim();
  if (!name || !address) {
    return Response.json({ error: "name and address are required" }, { status: 400 });
  }
  const db = getDb();
  const contact = await db.run(
    "INSERT INTO contacts (org_id, name, type, phone, email, address) VALUES (?,?,?,?,?,?)",
    auth.orgId, name, "Homeowner", String(body.phone ?? ""), String(body.email ?? ""), address,
  );
  const trade = String(body.trade ?? "Roofing");
  const rep = await db.get<{ id: number }>(
    "SELECT id FROM users WHERE role = 'rep' AND org_id = ? ORDER BY id LIMIT 1",
    auth.orgId,
  );
  const fallback = rep ?? (await db.get<{ id: number }>(
    "SELECT id FROM users WHERE org_id = ? ORDER BY id LIMIT 1",
    auth.orgId,
  ));
  const job = await db.run(
    `INSERT INTO jobs (org_id, title, contact_id, address, trade, source, stage, assignee_id)
     VALUES (?,?,?,?,?,?, 'Lead', ?)`,
    auth.orgId,
    String(body.title || `${trade} — ${name}`),
    contact.lastId,
    address,
    trade,
    String(body.source ?? "AI assistant"),
    fallback?.id ?? null,
  );
  await db.run(
    "INSERT INTO job_events (org_id, job_id, kind, body, actor) VALUES (?,?,?,?,?)",
    auth.orgId, job.lastId, "system", "Lead created", auth.identity.email,
  );
  return Response.json({
    job_id: job.lastId,
    stage: "Lead",
    title: String(body.title || `${trade} — ${name}`),
  });
}
