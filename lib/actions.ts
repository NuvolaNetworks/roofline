"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getDb, STAGES, type Stage } from "./db";
import { currentUser, login, logout } from "./auth";

async function actor(): Promise<string> {
  const user = await currentUser();
  if (!user) redirect("/login");
  return user.name;
}

function log(jobId: number, kind: string, body: string, who: string, direction = "internal") {
  getDb()
    .prepare(
      "INSERT INTO job_events (job_id, kind, body, actor, direction) VALUES (?,?,?,?,?)",
    )
    .run(jobId, kind, body, who, direction);
}

function touchJob(jobId: number) {
  getDb().prepare("UPDATE jobs SET updated_at = datetime('now') WHERE id = ?").run(jobId);
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
  const who = await actor();
  if (!STAGES.includes(stage as Stage)) return;
  getDb()
    .prepare(
      "UPDATE jobs SET stage = ?, stage_since = datetime('now'), updated_at = datetime('now') WHERE id = ?",
    )
    .run(stage, jobId);
  log(jobId, "stage", `Moved to ${stage}`, who);
  touchJob(jobId);
}

export async function advanceStage(jobId: number) {
  const db = getDb();
  const job = db.prepare("SELECT stage FROM jobs WHERE id = ?").get(jobId) as
    | { stage: Stage }
    | undefined;
  if (!job) return;
  const idx = STAGES.indexOf(job.stage);
  if (idx < 0 || idx >= STAGES.length - 1) return;
  await setStage(jobId, STAGES[idx + 1]);
}

export async function addNote(jobId: number, formData: FormData) {
  const who = await actor();
  const body = String(formData.get("body") ?? "").trim();
  if (!body) return;
  log(jobId, String(formData.get("kind") ?? "note"), body, who, String(formData.get("direction") ?? "internal"));
  touchJob(jobId);
}

export async function createLead(formData: FormData) {
  const user = await currentUser();
  if (!user) redirect("/login");
  const db = getDb();
  const name = String(formData.get("name") ?? "").trim();
  const address = String(formData.get("address") ?? "").trim();
  if (!name || !address) redirect("/leads/new?error=1");
  const contact = db
    .prepare("INSERT INTO contacts (name, type, phone, email, address) VALUES (?,?,?,?,?)")
    .run(name, "Homeowner", String(formData.get("phone") ?? ""), String(formData.get("email") ?? ""), address);
  const trade = String(formData.get("trade") ?? "Roofing");
  const job = db
    .prepare(
      `INSERT INTO jobs (title, contact_id, address, trade, workflow, source, stage, assignee_id)
       VALUES (?,?,?,?,?,?, 'New lead', ?)`,
    )
    .run(
      String(formData.get("title") || `${trade} — ${name}`),
      Number(contact.lastInsertRowid),
      address,
      trade,
      String(formData.get("workflow") ?? "Roofing"),
      String(formData.get("source") ?? "Office call"),
      Number(formData.get("assignee") || user.id),
    );
  log(Number(job.lastInsertRowid), "system", "Lead created", user.name);
  redirect(`/jobs/${job.lastInsertRowid}`);
}

// ── Measurements ─────────────────────────────────────────────────────

export async function orderMeasurement(jobId: number) {
  const who = await actor();
  getDb()
    .prepare(
      `INSERT INTO measurements (job_id, provider, status, total_squares, ridge_ft, hip_ft, valley_ft, eave_ft, rake_ft, pitch)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(jobId, "gaf_quickmeasure", "delivered", 30.6, 58, 24, 37, 141, 92, "6/12");
  log(jobId, "system", "GAF QuickMeasure report ordered and delivered", who);
  touchJob(jobId);
  revalidatePath("/measurements");
}

// ── Proposals ────────────────────────────────────────────────────────

/** Build a proposal from the job's newest measurement: squares × waste →
 *  material quantities, plus labor and disposal. This is the auto-fill the
 *  customer asked for — the measurement drives the line items. */
export async function createProposalFromMeasurement(jobId: number) {
  const who = await actor();
  const db = getDb();
  const m = db
    .prepare(
      "SELECT * FROM measurements WHERE job_id = ? AND status = 'delivered' ORDER BY id DESC LIMIT 1",
    )
    .get(jobId) as Record<string, number> | undefined;
  const squares = Number(m?.total_squares ?? 0) || 25;
  const waste = 1 + Number(m?.waste_pct ?? 12) / 100;
  const withWaste = Math.round(squares * waste * 10) / 10;
  const ridge = Number(m?.ridge_ft ?? 0) + Number(m?.hip_ft ?? 0);
  const eaveRake = Number(m?.eave_ft ?? 0) + Number(m?.rake_ft ?? 0);

  const cat = new Map(
    (
      db.prepare("SELECT sku, name, unit, price_cents, cost_cents FROM catalogue").all() as Array<
        Record<string, string | number>
      >
    ).map((r) => [String(r.sku), r]),
  );
  const plan: Array<[string, number]> = [
    ["GAF-TIMB-HDZ-CH", withWaste],
    ["SYN-FELT-10SQ", Math.max(1, Math.ceil(squares / 10))],
    ["ICE-WATER-2SQ", Math.max(1, Math.ceil(eaveRake / 100))],
    ["GAF-SEALAR-RIDGE", Math.max(1, Math.ceil(ridge / 20))],
    ["DRIP-F5-WHT-10", Math.max(1, Math.ceil(eaveRake / 10))],
    ["LAB-TEAROFF", squares],
    ["LAB-INSTALL", squares],
    ["DUMP-30YD", 1],
  ];

  const proposal = db
    .prepare("INSERT INTO proposals (job_id, name, status) VALUES (?,?, 'Draft')")
    .run(jobId, `Roof replacement — ${squares} sq`);
  const pid = Number(proposal.lastInsertRowid);
  const ins = db.prepare(
    "INSERT INTO proposal_lines (proposal_id, sku, name, unit, qty, unit_price_cents, unit_cost_cents) VALUES (?,?,?,?,?,?,?)",
  );
  let total = 0;
  let cost = 0;
  for (const [sku, qty] of plan) {
    const item = cat.get(sku);
    if (!item) continue;
    ins.run(pid, sku, String(item.name), String(item.unit), qty, Number(item.price_cents), Number(item.cost_cents));
    total += Math.round(Number(item.price_cents) * qty);
    cost += Math.round(Number(item.cost_cents) * qty);
  }
  db.prepare("UPDATE proposals SET total_cents = ?, cost_cents = ? WHERE id = ?").run(total, cost, pid);
  log(jobId, "system", `Proposal drafted from measurement (${squares} sq, ${Math.round((waste - 1) * 100)}% waste)`, who);
  touchJob(jobId);
  revalidatePath("/proposals");
  redirect(`/proposals/${pid}`);
}

export async function setProposalStatus(proposalId: number, status: string) {
  const who = await actor();
  const db = getDb();
  const p = db.prepare("SELECT job_id, total_cents, cost_cents FROM proposals WHERE id = ?").get(proposalId) as
    | { job_id: number; total_cents: number; cost_cents: number }
    | undefined;
  if (!p) return;
  const stamp =
    status === "Sent" ? ", sent_at = datetime('now')"
    : status === "Viewed" ? ", viewed_at = datetime('now')"
    : status === "Signed" ? ", signed_at = datetime('now')"
    : "";
  db.prepare(`UPDATE proposals SET status = ?${stamp} WHERE id = ?`).run(status, proposalId);
  log(p.job_id, status === "Signed" ? "stage" : "email", `Proposal ${status.toLowerCase()}`, who,
      status === "Sent" ? "outbound" : "internal");
  if (status === "Signed") {
    // A signed proposal is the job's value, and it moves the pipeline.
    db.prepare("UPDATE jobs SET value_cents = ?, cost_cents = ? WHERE id = ?").run(
      p.total_cents, p.cost_cents, p.job_id,
    );
    db.prepare(
      "INSERT INTO invoices (job_id, kind, amount_cents, status, due_on) VALUES (?,?,?, 'Draft', date('now','+3 days'))",
    ).run(p.job_id, "Deposit", Math.round(p.total_cents / 2));
    log(p.job_id, "system", "Deposit invoice drafted (50%)", who);
    await setStage(p.job_id, "Approved");
  }
  revalidatePath(`/proposals/${proposalId}`);
  revalidatePath("/proposals");
  touchJob(p.job_id);
}

// ── Documents (PDF signer + file manager) ────────────────────────────

export async function createDocument(jobId: number, formData: FormData) {
  const who = await actor();
  const db = getDb();
  const templateId = Number(formData.get("template_id"));
  const tpl = db.prepare("SELECT name FROM templates WHERE id = ?").get(templateId) as
    | { name: string }
    | undefined;
  const contact = db
    .prepare("SELECT c.name FROM jobs j JOIN contacts c ON c.id = j.contact_id WHERE j.id = ?")
    .get(jobId) as { name: string } | undefined;
  db.prepare(
    "INSERT INTO documents (job_id, template_id, name, status) VALUES (?,?,?, 'Sent')",
  ).run(jobId, templateId, `${tpl?.name ?? "Document"} — ${contact?.name ?? "job"}`);
  log(jobId, "email", `${tpl?.name ?? "Document"} sent for signature`, who, "outbound");
  touchJob(jobId);
  revalidatePath("/documents");
}

export async function signDocument(documentId: number) {
  const who = await actor();
  const db = getDb();
  const doc = db
    .prepare(
      "SELECT d.job_id, d.name, c.name AS signer FROM documents d JOIN jobs j ON j.id = d.job_id LEFT JOIN contacts c ON c.id = j.contact_id WHERE d.id = ?",
    )
    .get(documentId) as { job_id: number; name: string; signer: string } | undefined;
  if (!doc) return;
  db.prepare(
    "UPDATE documents SET status = 'Signed', signer = ?, signed_at = datetime('now') WHERE id = ?",
  ).run(doc.signer ?? "Homeowner", documentId);
  log(doc.job_id, "stage", `${doc.name} signed by ${doc.signer ?? "homeowner"}`, who);
  touchJob(doc.job_id);
  revalidatePath("/documents");
}

// ── Orders ───────────────────────────────────────────────────────────

/** Turn the job's signed/latest proposal into an SRS material order — the
 *  "order straight from the proposal" step. Parks as Pending approval: money
 *  leaves the business here, so a human confirms. */
export async function createMaterialOrder(jobId: number) {
  const who = await actor();
  const db = getDb();
  const p = db
    .prepare("SELECT id FROM proposals WHERE job_id = ? ORDER BY id DESC LIMIT 1")
    .get(jobId) as { id: number } | undefined;
  const materials = p
    ? (db
        .prepare(
          "SELECT COALESCE(SUM(qty * unit_cost_cents),0) AS c FROM proposal_lines WHERE proposal_id = ? AND sku NOT LIKE 'LAB-%'",
        )
        .get(p.id) as { c: number }).c
    : 0;
  db.prepare(
    "INSERT INTO material_orders (job_id, proposal_id, supplier, status, total_cents, deliver_on) VALUES (?,?,?, 'Pending approval', ?, date('now','+5 days'))",
  ).run(jobId, p?.id ?? null, "SRS Roof Hub", Math.round(materials));
  log(jobId, "system", "Material order drafted from proposal — pending approval", who);
  touchJob(jobId);
  revalidatePath("/orders");
}

export async function advanceMaterialOrder(orderId: number) {
  const who = await actor();
  const db = getDb();
  const o = db.prepare("SELECT job_id, status FROM material_orders WHERE id = ?").get(orderId) as
    | { job_id: number; status: string }
    | undefined;
  if (!o) return;
  const next = o.status === "Draft" ? "Pending approval" : o.status === "Pending approval" ? "Ordered" : "Delivered";
  db.prepare("UPDATE material_orders SET status = ? WHERE id = ?").run(next, orderId);
  log(o.job_id, "system", `Material order ${next.toLowerCase()}`, who);
  touchJob(o.job_id);
  revalidatePath("/orders");
}

export async function createWorkOrder(jobId: number, formData: FormData) {
  const who = await actor();
  getDb()
    .prepare(
      "INSERT INTO work_orders (job_id, trade, crew, scheduled_for, status, amount_cents, notes) VALUES (?,?,?,?, 'Sent', ?, ?)",
    )
    .run(
      jobId,
      String(formData.get("trade") ?? "Roofing"),
      String(formData.get("crew") ?? "In-house crew"),
      String(formData.get("scheduled_for") ?? ""),
      Math.round(Number(formData.get("amount") ?? 0) * 100),
      String(formData.get("notes") ?? ""),
    );
  log(jobId, "email", `Work order sent to ${String(formData.get("crew") ?? "crew")}`, who, "outbound");
  touchJob(jobId);
  revalidatePath("/orders");
}

// ── Invoices + payments ──────────────────────────────────────────────

export async function createInvoice(jobId: number, kind: string) {
  const who = await actor();
  const db = getDb();
  const job = db.prepare("SELECT value_cents FROM jobs WHERE id = ?").get(jobId) as
    | { value_cents: number }
    | undefined;
  const paid = (db
    .prepare("SELECT COALESCE(SUM(amount_cents),0) AS c FROM invoices WHERE job_id = ? AND status = 'Paid'")
    .get(jobId) as { c: number }).c;
  const amount = kind === "Deposit"
    ? Math.round(Number(job?.value_cents ?? 0) / 2)
    : Math.max(0, Number(job?.value_cents ?? 0) - paid);
  db.prepare(
    "INSERT INTO invoices (job_id, kind, amount_cents, status, due_on, sent_at) VALUES (?,?,?, 'Sent', date('now','+14 days'), datetime('now'))",
  ).run(jobId, kind, amount);
  log(jobId, "email", `${kind} invoice sent with payment link`, who, "outbound");
  touchJob(jobId);
  revalidatePath("/invoices");
}

export async function markInvoicePaid(invoiceId: number) {
  const who = await actor();
  const db = getDb();
  const inv = db.prepare("SELECT job_id, kind, amount_cents FROM invoices WHERE id = ?").get(invoiceId) as
    | { job_id: number; kind: string; amount_cents: number }
    | undefined;
  if (!inv) return;
  db.prepare("UPDATE invoices SET status = 'Paid', paid_at = datetime('now') WHERE id = ?").run(invoiceId);
  db.prepare(
    "INSERT INTO payments (invoice_id, amount_cents, method, reference) VALUES (?,?,?,?)",
  ).run(invoiceId, inv.amount_cents, "Card", `ch_${Math.random().toString(36).slice(2, 10)}`);
  log(inv.job_id, "system", `${inv.kind} payment received`, who);
  if (inv.kind === "Balance") await setStage(inv.job_id, "Ready for Commission");
  touchJob(inv.job_id);
  revalidatePath("/invoices");
  revalidatePath("/payments");
}

// ── Tasks + automations ──────────────────────────────────────────────

export async function toggleTask(taskId: number) {
  await actor();
  getDb().prepare("UPDATE tasks SET done = 1 - done WHERE id = ?").run(taskId);
  revalidatePath("/");
}

export async function toggleAutomation(automationId: number) {
  await actor();
  getDb().prepare("UPDATE automations SET enabled = 1 - enabled WHERE id = ?").run(automationId);
  revalidatePath("/automations");
}

// ── Public instant estimator ─────────────────────────────────────────

/** No session: this is the QR/website lead form. Creates the contact + job
 *  with a Solar-API-style rough estimate attached. */
export async function submitInstantEstimate(formData: FormData) {
  const db = getDb();
  const name = String(formData.get("name") ?? "").trim();
  const address = String(formData.get("address") ?? "").trim();
  if (!name || !address) redirect("/estimate?error=1");
  const contact = db
    .prepare("INSERT INTO contacts (name, type, phone, email, address) VALUES (?,?,?,?,?)")
    .run(name, "Homeowner", String(formData.get("phone") ?? ""), String(formData.get("email") ?? ""), address);
  const trade = String(formData.get("trade") ?? "Roofing");
  const rep = db.prepare("SELECT id FROM users WHERE role = 'rep' ORDER BY RANDOM() LIMIT 1").get() as
    | { id: number }
    | undefined;
  const job = db
    .prepare(
      `INSERT INTO jobs (title, contact_id, address, trade, workflow, source, stage, assignee_id)
       VALUES (?,?,?,?, 'Roofing', 'QR instant estimate', 'New lead', ?)`,
    )
    .run(`${trade} — ${name}`, Number(contact.lastInsertRowid), address, trade, rep?.id ?? 1);
  const jobId = Number(job.lastInsertRowid);
  // Rough, clearly-labelled estimate — the contract-grade report is ordered later.
  const squares = 22 + Math.round(Math.random() * 18);
  db.prepare(
    `INSERT INTO measurements (job_id, provider, status, total_squares, pitch)
     VALUES (?, 'solar_estimate', 'delivered', ?, '5/12 (est)')`,
  ).run(jobId, squares);
  db.prepare(
    "INSERT INTO job_events (job_id, kind, body, actor, direction) VALUES (?,?,?,?,?)",
  ).run(jobId, "system", `Instant estimate requested online — ~${squares} squares`, "instant estimator", "inbound");
  redirect(`/estimate/thanks?sq=${squares}`);
}
