"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getDb, STAGES, type Stage } from "./db";
import { currentUser, login, logout } from "./auth";

export async function loginAction(formData: FormData) {
  const ok = await login(
    String(formData.get("email") ?? ""),
    String(formData.get("password") ?? ""),
  );
  redirect(ok ? "/" : "/login?error=1");
}

export async function logoutAction() {
  await logout();
  redirect("/login");
}

export async function advanceStage(jobId: number) {
  const user = await currentUser();
  if (!user) redirect("/login");
  const db = getDb();
  const job = db.prepare("SELECT stage FROM jobs WHERE id = ?").get(jobId) as
    | { stage: Stage }
    | undefined;
  if (!job) return;
  const idx = STAGES.indexOf(job.stage);
  if (idx < 0 || idx >= STAGES.length - 1) return;
  const next = STAGES[idx + 1];
  db.prepare("UPDATE jobs SET stage = ?, updated_at = datetime('now') WHERE id = ?").run(
    next,
    jobId,
  );
  db.prepare(
    "INSERT INTO job_events (job_id, kind, body, actor) VALUES (?,?,?,?)",
  ).run(jobId, "stage", `Moved to ${next}`, user.name);
  revalidatePath(`/jobs/${jobId}`);
  revalidatePath("/");
}

export async function addNote(jobId: number, formData: FormData) {
  const user = await currentUser();
  if (!user) redirect("/login");
  const body = String(formData.get("body") ?? "").trim();
  if (!body) return;
  getDb()
    .prepare("INSERT INTO job_events (job_id, kind, body, actor) VALUES (?,?,?,?)")
    .run(jobId, "note", body, user.name);
  revalidatePath(`/jobs/${jobId}`);
}

export async function orderMeasurement(jobId: number) {
  const user = await currentUser();
  if (!user) redirect("/login");
  const db = getDb();
  // Demo: the QuickMeasure/EagleView order API is stubbed — a report is
  // "delivered" immediately with plausible numbers. The integration point
  // (order → webhook → delivered) is exactly this function.
  db.prepare(
    `INSERT INTO measurements (job_id, provider, status, total_squares, ridge_ft, hip_ft, valley_ft, eave_ft, rake_ft, pitch)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(jobId, "gaf_quickmeasure", "delivered", 30.6, 58, 24, 37, 141, 92, "6/12");
  db.prepare(
    "INSERT INTO job_events (job_id, kind, body, actor) VALUES (?,?,?,?)",
  ).run(jobId, "system", "GAF QuickMeasure report ordered and delivered", user.name);
  revalidatePath(`/jobs/${jobId}`);
}

export async function createLead(formData: FormData) {
  const user = await currentUser();
  if (!user) redirect("/login");
  const db = getDb();
  const name = String(formData.get("name") ?? "").trim();
  const address = String(formData.get("address") ?? "").trim();
  if (!name || !address) redirect("/leads/new?error=1");
  const contact = db
    .prepare(
      "INSERT INTO contacts (name, type, phone, email, address) VALUES (?,?,?,?,?)",
    )
    .run(
      name,
      "Homeowner",
      String(formData.get("phone") ?? ""),
      String(formData.get("email") ?? ""),
      address,
    );
  const job = db
    .prepare(
      `INSERT INTO jobs (title, contact_id, address, trade, source, stage, assignee_id)
       VALUES (?,?,?,?,?, 'Lead', ?)`,
    )
    .run(
      String(formData.get("title") || `${String(formData.get("trade") || "Roofing")} — ${name}`),
      Number(contact.lastInsertRowid),
      address,
      String(formData.get("trade") ?? "Roofing"),
      String(formData.get("source") ?? "Office call"),
      Number(formData.get("assignee") || user.id),
    );
  db.prepare(
    "INSERT INTO job_events (job_id, kind, body, actor) VALUES (?,?,?,?)",
  ).run(Number(job.lastInsertRowid), "system", "Lead created", user.name);
  redirect(`/jobs/${job.lastInsertRowid}`);
}

export async function saveIntegrationKey(formData: FormData) {
  const user = await currentUser();
  if (!user || user.role === "rep") redirect("/login");
  const key = String(formData.get("srs_key") ?? "").trim();
  getDb()
    .prepare(
      "INSERT INTO settings (key, value) VALUES ('srs_roofhub_key', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .run(key);
  revalidatePath("/settings");
}
