"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { getDb, STAGES, type Stage } from "./db";
import { authMode, currentUser, login, logout, type User } from "./auth";
import { DEMO_ESTIMATOR_TOKEN } from "./demo-fixtures";
import { createFixedWindowLimiter } from "./rate-limit";
import { buildProposalFromMeasurement } from "./proposal-ops";

/** Authenticated user, or bounce to login. Their org_id scopes every query
 *  in this file — org NEVER comes from client input. */
async function requireUser(): Promise<User> {
  const user = await currentUser();
  if (!user) redirect("/login");
  return user;
}

async function log(
  orgId: string,
  jobId: number,
  kind: string,
  body: string,
  who: string,
  direction = "internal",
) {
  await getDb().run(
    "INSERT INTO job_events (org_id, job_id, kind, body, actor, direction) VALUES (?,?,?,?,?,?)",
    orgId, jobId, kind, body, who, direction,
  );
}

async function touchJob(orgId: string, jobId: number) {
  await getDb().run(
    "UPDATE jobs SET updated_at = datetime('now') WHERE id = ? AND org_id = ?",
    jobId, orgId,
  );
  revalidatePath(`/jobs/${jobId}`);
  revalidatePath("/jobs");
}

// ── Session ──────────────────────────────────────────────────────────

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

// ── Pipeline ─────────────────────────────────────────────────────────

export async function setStage(jobId: number, stage: string) {
  const user = await requireUser();
  if (!STAGES.includes(stage as Stage)) return;
  await getDb().run(
    "UPDATE jobs SET stage = ?, stage_since = datetime('now'), updated_at = datetime('now') WHERE id = ? AND org_id = ?",
    stage, jobId, user.org_id,
  );
  await log(user.org_id, jobId, "stage", `Moved to ${stage}`, user.name);
  await touchJob(user.org_id, jobId);
}

export async function advanceStage(jobId: number) {
  const user = await requireUser();
  const job = await getDb().get<{ stage: Stage }>(
    "SELECT stage FROM jobs WHERE id = ? AND org_id = ?",
    jobId, user.org_id,
  );
  if (!job) return;
  const idx = STAGES.indexOf(job.stage);
  if (idx < 0 || idx >= STAGES.length - 1) return;
  await setStage(jobId, STAGES[idx + 1]);
}

export async function addNote(jobId: number, formData: FormData) {
  const user = await requireUser();
  const body = String(formData.get("body") ?? "").trim();
  if (!body) return;
  const job = await getDb().get<{ id: number }>(
    "SELECT id FROM jobs WHERE id = ? AND org_id = ?",
    jobId, user.org_id,
  );
  if (!job) return;
  await log(
    user.org_id, jobId,
    String(formData.get("kind") ?? "note"), body, user.name,
    String(formData.get("direction") ?? "internal"),
  );
  await touchJob(user.org_id, jobId);
}

export async function createLead(formData: FormData) {
  const user = await requireUser();
  const db = getDb();
  const name = String(formData.get("name") ?? "").trim();
  const address = String(formData.get("address") ?? "").trim();
  if (!name || !address) redirect("/leads/new?error=1");
  const contact = await db.run(
    "INSERT INTO contacts (org_id, name, type, phone, email, address) VALUES (?,?,?,?,?,?)",
    user.org_id, name, "Homeowner",
    String(formData.get("phone") ?? ""), String(formData.get("email") ?? ""), address,
  );
  const trade = String(formData.get("trade") ?? "Roofing");
  // The assignee comes from the form but must be a user of THIS org.
  const requested = Number(formData.get("assignee") || user.id);
  const assignee = await db.get<{ id: number }>(
    "SELECT id FROM users WHERE id = ? AND org_id = ?",
    requested, user.org_id,
  );
  const job = await db.run(
    `INSERT INTO jobs (org_id, title, contact_id, address, trade, workflow, source, stage, assignee_id)
     VALUES (?,?,?,?,?,?,?, 'New lead', ?)`,
    user.org_id,
    String(formData.get("title") || `${trade} — ${name}`),
    contact.lastId,
    address,
    trade,
    String(formData.get("workflow") ?? "Roofing"),
    String(formData.get("source") ?? "Office call"),
    assignee?.id ?? user.id,
  );
  await log(user.org_id, job.lastId, "system", "Lead created", user.name);
  redirect(`/jobs/${job.lastId}`);
}

// ── Measurements ─────────────────────────────────────────────────────

export async function orderMeasurement(jobId: number) {
  const user = await requireUser();
  const db = getDb();
  const job = await db.get<{ id: number }>(
    "SELECT id FROM jobs WHERE id = ? AND org_id = ?",
    jobId, user.org_id,
  );
  if (!job) return;
  await db.run(
    `INSERT INTO measurements (org_id, job_id, provider, status, total_squares, ridge_ft, hip_ft, valley_ft, eave_ft, rake_ft, pitch)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    user.org_id, jobId, "gaf_quickmeasure", "delivered", 30.6, 58, 24, 37, 141, 92, "6/12",
  );
  await log(user.org_id, jobId, "system", "GAF QuickMeasure report ordered and delivered", user.name);
  await touchJob(user.org_id, jobId);
  revalidatePath("/measurements");
}

// ── Proposals ────────────────────────────────────────────────────────

/** Build a proposal from the job's newest measurement: squares × waste →
 *  material quantities, plus labor and disposal. This is the auto-fill the
 *  customer asked for — the measurement drives the line items. */
export async function createProposalFromMeasurement(jobId: number) {
  const user = await requireUser();
  const job = await getDb().get<{ id: number }>("SELECT id FROM jobs WHERE id = ? AND org_id = ?", jobId, user.org_id);
  if (!job) return;
  const pid = await buildProposalFromMeasurement(getDb(), user.org_id, jobId, user);
  await touchJob(user.org_id, jobId);
  revalidatePath("/proposals");
  redirect(`/proposals/${pid}`);
}

// ── Documents (PDF signer + file manager) ────────────────────────────

export async function createDocument(jobId: number, formData: FormData) {
  const user = await requireUser();
  const db = getDb();
  const templateId = Number(formData.get("template_id"));
  const tpl = await db.get<{ name: string }>(
    "SELECT name FROM templates WHERE id = ? AND org_id = ?",
    templateId, user.org_id,
  );
  const contact = await db.get<{ name: string }>(
    "SELECT c.name FROM jobs j JOIN contacts c ON c.id = j.contact_id WHERE j.id = ? AND j.org_id = ?",
    jobId, user.org_id,
  );
  const job = await db.get<{ id: number }>(
    "SELECT id FROM jobs WHERE id = ? AND org_id = ?",
    jobId, user.org_id,
  );
  if (!job) return;
  await db.run(
    "INSERT INTO documents (org_id, job_id, template_id, name, status) VALUES (?,?,?,?, 'Sent')",
    user.org_id, jobId, tpl ? templateId : null,
    `${tpl?.name ?? "Document"} — ${contact?.name ?? "job"}`,
  );
  await log(user.org_id, jobId, "email", `${tpl?.name ?? "Document"} sent for signature`, user.name, "outbound");
  await touchJob(user.org_id, jobId);
  revalidatePath("/documents");
}

export async function signDocument(documentId: number) {
  const user = await requireUser();
  const db = getDb();
  const doc = await db.get<{ job_id: number; name: string; signer: string | null }>(
    `SELECT d.job_id, d.name, c.name AS signer FROM documents d
     JOIN jobs j ON j.id = d.job_id LEFT JOIN contacts c ON c.id = j.contact_id
     WHERE d.id = ? AND d.org_id = ?`,
    documentId, user.org_id,
  );
  if (!doc) return;
  await db.run(
    "UPDATE documents SET status = 'Signed', signer = ?, signed_at = datetime('now') WHERE id = ? AND org_id = ?",
    doc.signer ?? "Homeowner", documentId, user.org_id,
  );
  await log(user.org_id, doc.job_id, "stage", `${doc.name} signed by ${doc.signer ?? "homeowner"}`, user.name);
  await touchJob(user.org_id, doc.job_id);
  revalidatePath("/documents");
}

// ── Orders ───────────────────────────────────────────────────────────

/** Turn the job's signed/latest proposal into an SRS material order — the
 *  "order straight from the proposal" step. Parks as Pending approval: money
 *  leaves the business here, so a human confirms. */
export async function createMaterialOrder(jobId: number) {
  const user = await requireUser();
  const db = getDb();
  const job = await db.get<{ id: number }>(
    "SELECT id FROM jobs WHERE id = ? AND org_id = ?",
    jobId, user.org_id,
  );
  if (!job) return;
  const p = await db.get<{ id: number }>(
    "SELECT id FROM proposals WHERE job_id = ? AND org_id = ? ORDER BY id DESC LIMIT 1",
    jobId, user.org_id,
  );
  const materials = p
    ? (
        await db.get<{ c: number }>(
          "SELECT COALESCE(SUM(qty * unit_cost_cents),0) AS c FROM proposal_lines WHERE proposal_id = ? AND org_id = ? AND sku NOT LIKE 'LAB-%'",
          p.id, user.org_id,
        )
      )!.c
    : 0;
  await db.run(
    "INSERT INTO material_orders (org_id, job_id, proposal_id, supplier, status, total_cents, deliver_on) VALUES (?,?,?,?, 'Pending approval', ?, date('now','+5 days'))",
    user.org_id, jobId, p?.id ?? null, "SRS Roof Hub", Math.round(materials),
  );
  await log(user.org_id, jobId, "system", "Material order drafted from proposal — pending approval", user.name);
  await touchJob(user.org_id, jobId);
  revalidatePath("/orders");
}

export async function advanceMaterialOrder(orderId: number) {
  const user = await requireUser();
  const db = getDb();
  const o = await db.get<{ job_id: number; status: string }>(
    "SELECT job_id, status FROM material_orders WHERE id = ? AND org_id = ?",
    orderId, user.org_id,
  );
  if (!o) return;
  const next = o.status === "Draft" ? "Pending approval" : o.status === "Pending approval" ? "Ordered" : "Delivered";
  await db.run(
    "UPDATE material_orders SET status = ? WHERE id = ? AND org_id = ?",
    next, orderId, user.org_id,
  );
  await log(user.org_id, o.job_id, "system", `Material order ${next.toLowerCase()}`, user.name);
  await touchJob(user.org_id, o.job_id);
  revalidatePath("/orders");
}

export async function createWorkOrder(jobId: number, formData: FormData) {
  const user = await requireUser();
  const db = getDb();
  const job = await db.get<{ id: number }>(
    "SELECT id FROM jobs WHERE id = ? AND org_id = ?",
    jobId, user.org_id,
  );
  if (!job) return;
  await db.run(
    "INSERT INTO work_orders (org_id, job_id, trade, crew, scheduled_for, status, amount_cents, notes) VALUES (?,?,?,?,?, 'Sent', ?, ?)",
    user.org_id, jobId,
    String(formData.get("trade") ?? "Roofing"),
    String(formData.get("crew") ?? "In-house crew"),
    String(formData.get("scheduled_for") ?? ""),
    Math.round(Number(formData.get("amount") ?? 0) * 100),
    String(formData.get("notes") ?? ""),
  );
  await log(user.org_id, jobId, "email", `Work order sent to ${String(formData.get("crew") ?? "crew")}`, user.name, "outbound");
  await touchJob(user.org_id, jobId);
  revalidatePath("/orders");
}

// ── Tasks + automations ──────────────────────────────────────────────

export async function toggleTask(taskId: number) {
  const user = await requireUser();
  await getDb().run(
    "UPDATE tasks SET done = 1 - done WHERE id = ? AND org_id = ?",
    taskId, user.org_id,
  );
  revalidatePath("/");
}

export async function toggleAutomation(automationId: number) {
  const user = await requireUser();
  await getDb().run(
    "UPDATE automations SET enabled = 1 - enabled WHERE id = ? AND org_id = ?",
    automationId, user.org_id,
  );
  revalidatePath("/automations");
}

// ── Public instant estimator ─────────────────────────────────────────

// Best-effort in-process rate limit for the unauthenticated estimator, keyed
// by estimator token + client IP. It caps casual abuse (and per-token flooding
// of one org's pipeline); it is NOT a substitute for a CAPTCHA / edge WAF,
// which is the intended follow-up. Per-instance only — resets on redeploy.
const estimateRateLimited = createFixedWindowLimiter({ windowMs: 60_000, max: 5 });

/** No session: this is the QR/website lead form. The target org is addressed
 *  by its estimator TOKEN (?token=…), never its primary key — the token is
 *  random, non-enumerable and revocable (H1). In demo mode it defaults to the
 *  demo org's token. Write-only into that org: the form can create a lead
 *  there and read nothing, and the row is tagged source='QR instant estimate'
 *  so downstream treats its free-text as untrusted. */
export async function submitInstantEstimate(formData: FormData) {
  const db = getDb();
  const name = String(formData.get("name") ?? "").trim();
  const address = String(formData.get("address") ?? "").trim();
  let token = String(formData.get("token") ?? "").trim();
  if (!token && authMode() === "demo") token = DEMO_ESTIMATOR_TOKEN;
  // Resolve the org strictly by token — a client-supplied id is never trusted.
  const org = token
    ? await db.get<{ id: string }>("SELECT id FROM orgs WHERE estimator_token = ?", token)
    : undefined;
  if (!org) redirect("/estimate/form?error=org");
  const orgId = org.id;
  if (!name || !address) redirect(`/estimate/form?token=${encodeURIComponent(token)}&error=1`);
  const ip =
    (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (estimateRateLimited(`${token}|${ip}`)) {
    redirect(`/estimate/form?token=${encodeURIComponent(token)}&error=rate`);
  }
  const contact = await db.run(
    "INSERT INTO contacts (org_id, name, type, phone, email, address) VALUES (?,?,?,?,?,?)",
    orgId, name, "Homeowner",
    String(formData.get("phone") ?? ""), String(formData.get("email") ?? ""), address,
  );
  const trade = String(formData.get("trade") ?? "Roofing");
  const rep = await db.get<{ id: number }>(
    "SELECT id FROM users WHERE role = 'rep' AND org_id = ? ORDER BY RANDOM() LIMIT 1",
    orgId,
  );
  const fallback = rep ?? (await db.get<{ id: number }>(
    "SELECT id FROM users WHERE org_id = ? ORDER BY id LIMIT 1",
    orgId,
  ));
  const job = await db.run(
    `INSERT INTO jobs (org_id, title, contact_id, address, trade, workflow, source, stage, assignee_id)
     VALUES (?,?,?,?,?, 'Roofing', 'QR instant estimate', 'New lead', ?)`,
    orgId, `${trade} — ${name}`, contact.lastId, address, trade, fallback?.id ?? null,
  );
  const jobId = job.lastId;
  // Rough, clearly-labelled estimate — the contract-grade report is ordered later.
  const squares = 22 + Math.round(Math.random() * 18);
  await db.run(
    `INSERT INTO measurements (org_id, job_id, provider, status, total_squares, pitch)
     VALUES (?,?, 'solar_estimate', 'delivered', ?, '5/12 (est)')`,
    orgId, jobId, squares,
  );
  await db.run(
    "INSERT INTO job_events (org_id, job_id, kind, body, actor, direction) VALUES (?,?,?,?,?,?)",
    orgId, jobId, "system", `Instant estimate requested online — ~${squares} squares`, "instant estimator", "inbound",
  );
  redirect(`/estimate/thanks?sq=${squares}`);
}
