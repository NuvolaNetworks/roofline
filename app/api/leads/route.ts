import { getDb } from "@/lib/db";
import { requireIdentity } from "@/lib/api-guard";

/** POST /api/leads — capture a new lead and open its job file. */
export async function POST(req: Request) {
  const auth = await requireIdentity(req);
  if ("error" in auth) return auth.error;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const name = String(body.name ?? "").trim();
  const address = String(body.address ?? "").trim();
  if (!name || !address) {
    return Response.json({ error: "name and address are required" }, { status: 400 });
  }
  const db = getDb();
  const contact = db
    .prepare("INSERT INTO contacts (name, type, phone, email, address) VALUES (?,?,?,?,?)")
    .run(name, "Homeowner", String(body.phone ?? ""), String(body.email ?? ""), address);
  const trade = String(body.trade ?? "Roofing");
  const rep = db.prepare("SELECT id FROM users WHERE role = 'rep' ORDER BY id LIMIT 1").get() as
    | { id: number }
    | undefined;
  const job = db
    .prepare(
      `INSERT INTO jobs (title, contact_id, address, trade, source, stage, assignee_id)
       VALUES (?,?,?,?,?, 'Lead', ?)`,
    )
    .run(
      String(body.title || `${trade} — ${name}`),
      Number(contact.lastInsertRowid),
      address,
      trade,
      String(body.source ?? "AI assistant"),
      rep?.id ?? 1,
    );
  db.prepare("INSERT INTO job_events (job_id, kind, body, actor) VALUES (?,?,?,?)").run(
    Number(job.lastInsertRowid),
    "system",
    "Lead created",
    auth.identity.email,
  );
  return Response.json({ job_id: Number(job.lastInsertRowid), stage: "Lead", title: String(body.title || `${trade} — ${name}`) });
}
