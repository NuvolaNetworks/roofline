/**
 * import-snapshot — load a customer's data into one org.
 *
 * Usage:
 *   DATABASE_URL=postgres://… node scripts/import-snapshot.ts snapshot.json --org <org uuid>
 *   (omit DATABASE_URL to import into the local sqlite demo database)
 *
 * Snapshot JSON shape — rows reference each other by `ref`, a snapshot-local
 * string key; the importer assigns fresh database ids and rewires the
 * relationships. Only `contacts[].ref` and `jobs[].ref` are referenced;
 * everything else hangs off a job. All *_cents are integers; dates are
 * "YYYY-MM-DD"; timestamps "YYYY-MM-DD HH:MM:SS" (UTC).
 *
 * {
 *   "contacts": [{ "ref": "c1", "name": "…", "type": "Homeowner",
 *                  "phone": "", "email": "", "address": "" }],
 *   "jobs":     [{ "ref": "j1", "title": "…", "contact_ref": "c1",
 *                  "address": "…", "trade": "Roofing", "workflow": "Roofing",
 *                  "source": "Referral", "stage": "New lead",
 *                  "value_cents": 0, "cost_cents": 0,
 *                  "scheduled_for": null, "created_at": null }],
 *   "proposals":[{ "job_ref": "j1", "name": "…", "status": "Draft",
 *                  "total_cents": 0, "cost_cents": 0,
 *                  "lines": [{ "sku": "…", "name": "…", "unit": "…",
 *                              "qty": 1, "unit_price_cents": 0,
 *                              "unit_cost_cents": 0 }] }],
 *   "invoices": [{ "job_ref": "j1", "kind": "Deposit", "amount_cents": 0,
 *                  "status": "Sent", "due_on": null,
 *                  "payments": [{ "amount_cents": 0, "method": "Card",
 *                                 "reference": null, "received_at": null }] }],
 *   "tasks":    [{ "job_ref": "j1", "title": "…", "due_on": null, "done": 0 }],
 *   "events":   [{ "job_ref": "j1", "kind": "note", "body": "…",
 *                  "actor": "…", "direction": "internal",
 *                  "created_at": null }]
 * }
 *
 * Behavior:
 *   - rows whose contact name / job title matches the demo seed data are
 *     skipped (and everything hanging off a skipped job is skipped with it);
 *   - idempotent on re-run: natural-key lookup before insert —
 *       contact  (org, name, address)
 *       job      (org, title, address)
 *       proposal (org, job, name)         — lines only on first insert
 *       invoice  (org, job, kind, amount) — payments only on first insert
 *       task     (org, job, title)
 *       event    (org, job, kind, body, actor)
 *   - org must already exist (provisioned by first login); ids are never
 *     taken from the snapshot.
 */
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { getDb, closeDb, STAGES, type Db, type Stage } from "../lib/db.ts";
import { DEMO_CONTACT_NAMES, DEMO_JOB_TITLES } from "../lib/demo-fixtures.ts";

interface SnapshotContact {
  ref: string;
  name: string;
  type?: string;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
}
interface SnapshotJob {
  ref: string;
  title: string;
  contact_ref?: string | null;
  address: string;
  trade?: string;
  workflow?: string;
  source?: string;
  stage?: string;
  value_cents?: number;
  cost_cents?: number;
  scheduled_for?: string | null;
  created_at?: string | null;
}
interface SnapshotProposalLine {
  sku: string;
  name: string;
  unit: string;
  qty: number;
  unit_price_cents: number;
  unit_cost_cents?: number;
}
interface SnapshotProposal {
  job_ref: string;
  name: string;
  status?: string;
  total_cents?: number;
  cost_cents?: number;
  lines?: SnapshotProposalLine[];
}
interface SnapshotPayment {
  amount_cents: number;
  method?: string;
  reference?: string | null;
  received_at?: string | null;
}
interface SnapshotInvoice {
  job_ref: string;
  kind: string;
  amount_cents: number;
  status?: string;
  due_on?: string | null;
  payments?: SnapshotPayment[];
}
interface SnapshotTask {
  job_ref: string;
  title: string;
  due_on?: string | null;
  done?: number;
}
interface SnapshotEvent {
  job_ref: string;
  kind: string;
  body: string;
  actor: string;
  direction?: string;
  created_at?: string | null;
}
export interface Snapshot {
  contacts?: SnapshotContact[];
  jobs?: SnapshotJob[];
  proposals?: SnapshotProposal[];
  invoices?: SnapshotInvoice[];
  tasks?: SnapshotTask[];
  events?: SnapshotEvent[];
}

export interface ImportCounts {
  inserted: number;
  existing: number;
  skippedDemo: number;
  skippedDangling: number;
}
export type ImportReport = Record<
  "contacts" | "jobs" | "proposals" | "invoices" | "tasks" | "events",
  ImportCounts
>;

const zero = (): ImportCounts => ({ inserted: 0, existing: 0, skippedDemo: 0, skippedDangling: 0 });

export async function importSnapshot(orgId: string, snapshot: Snapshot): Promise<ImportReport> {
  const db: Db = getDb();
  const org = await db.get<{ id: string }>("SELECT id FROM orgs WHERE id = ?", orgId);
  if (!org) throw new Error(`org ${orgId} does not exist — provision it (first login) before importing`);

  const report: ImportReport = {
    contacts: zero(), jobs: zero(), proposals: zero(),
    invoices: zero(), tasks: zero(), events: zero(),
  };

  // ── Contacts ──
  const contactIdByRef = new Map<string, number>();
  for (const c of snapshot.contacts ?? []) {
    if (DEMO_CONTACT_NAMES.has(c.name.trim().toLowerCase())) {
      report.contacts.skippedDemo++;
      continue;
    }
    const existing = await db.get<{ id: number }>(
      "SELECT id FROM contacts WHERE org_id = ? AND lower(name) = ? AND lower(COALESCE(address,'')) = ?",
      orgId, c.name.trim().toLowerCase(), (c.address ?? "").trim().toLowerCase(),
    );
    if (existing) {
      contactIdByRef.set(c.ref, existing.id);
      report.contacts.existing++;
      continue;
    }
    const r = await db.run(
      "INSERT INTO contacts (org_id, name, type, phone, email, address) VALUES (?,?,?,?,?,?)",
      orgId, c.name.trim(), c.type ?? "Homeowner", c.phone ?? "", c.email ?? "", c.address ?? "",
    );
    contactIdByRef.set(c.ref, r.lastId);
    report.contacts.inserted++;
  }

  // ── Jobs ──
  const jobIdByRef = new Map<string, number>();
  for (const j of snapshot.jobs ?? []) {
    if (DEMO_JOB_TITLES.has(j.title.trim().toLowerCase())) {
      report.jobs.skippedDemo++;
      continue;
    }
    const existing = await db.get<{ id: number }>(
      "SELECT id FROM jobs WHERE org_id = ? AND lower(title) = ? AND lower(address) = ?",
      orgId, j.title.trim().toLowerCase(), j.address.trim().toLowerCase(),
    );
    if (existing) {
      jobIdByRef.set(j.ref, existing.id);
      report.jobs.existing++;
      continue;
    }
    const stage: Stage = STAGES.includes(j.stage as Stage) ? (j.stage as Stage) : "New lead";
    const contactId = j.contact_ref ? contactIdByRef.get(j.contact_ref) ?? null : null;
    if (j.contact_ref && contactId === null) {
      // Contact was skipped (demo/dangling); keep the job, drop the link.
      console.warn(`  · job "${j.title}": contact_ref ${j.contact_ref} unresolved — importing unlinked`);
    }
    const r = await db.run(
      `INSERT INTO jobs (org_id, title, contact_id, address, trade, workflow, source, stage,
                         value_cents, cost_cents, scheduled_for, created_at, stage_since)
       VALUES (?,?,?,?,?,?,?,?,?,?,?, COALESCE(?, datetime('now')), datetime('now'))`,
      orgId, j.title.trim(), contactId, j.address.trim(),
      j.trade ?? "Roofing", j.workflow ?? "Roofing", j.source ?? "Import", stage,
      Math.round(j.value_cents ?? 0), Math.round(j.cost_cents ?? 0),
      j.scheduled_for ?? null, j.created_at ?? null,
    );
    jobIdByRef.set(j.ref, r.lastId);
    report.jobs.inserted++;
  }

  const jobFor = (ref: string, kind: keyof ImportReport): number | null => {
    const id = jobIdByRef.get(ref);
    if (id === undefined) {
      report[kind].skippedDangling++;
      return null;
    }
    return id;
  };

  // ── Proposals (+ lines) ──
  for (const p of snapshot.proposals ?? []) {
    const jobId = jobFor(p.job_ref, "proposals");
    if (jobId === null) continue;
    const existing = await db.get<{ id: number }>(
      "SELECT id FROM proposals WHERE org_id = ? AND job_id = ? AND lower(name) = ?",
      orgId, jobId, p.name.trim().toLowerCase(),
    );
    if (existing) {
      report.proposals.existing++;
      continue;
    }
    const r = await db.run(
      "INSERT INTO proposals (org_id, job_id, name, status, total_cents, cost_cents) VALUES (?,?,?,?,?,?)",
      orgId, jobId, p.name.trim(), p.status ?? "Draft",
      Math.round(p.total_cents ?? 0), Math.round(p.cost_cents ?? 0),
    );
    for (const l of p.lines ?? []) {
      await db.run(
        "INSERT INTO proposal_lines (org_id, proposal_id, sku, name, unit, qty, unit_price_cents, unit_cost_cents) VALUES (?,?,?,?,?,?,?,?)",
        orgId, r.lastId, l.sku, l.name, l.unit, l.qty,
        Math.round(l.unit_price_cents), Math.round(l.unit_cost_cents ?? 0),
      );
    }
    report.proposals.inserted++;
  }

  // ── Invoices (+ payments) ──
  for (const i of snapshot.invoices ?? []) {
    const jobId = jobFor(i.job_ref, "invoices");
    if (jobId === null) continue;
    const existing = await db.get<{ id: number }>(
      "SELECT id FROM invoices WHERE org_id = ? AND job_id = ? AND kind = ? AND amount_cents = ?",
      orgId, jobId, i.kind, Math.round(i.amount_cents),
    );
    if (existing) {
      report.invoices.existing++;
      continue;
    }
    const r = await db.run(
      "INSERT INTO invoices (org_id, job_id, kind, amount_cents, status, due_on) VALUES (?,?,?,?,?,?)",
      orgId, jobId, i.kind, Math.round(i.amount_cents), i.status ?? "Draft", i.due_on ?? null,
    );
    for (const pay of i.payments ?? []) {
      await db.run(
        "INSERT INTO payments (org_id, invoice_id, amount_cents, method, reference, received_at) VALUES (?,?,?,?,?, COALESCE(?, datetime('now')))",
        orgId, r.lastId, Math.round(pay.amount_cents), pay.method ?? "Card",
        pay.reference ?? null, pay.received_at ?? null,
      );
    }
    report.invoices.inserted++;
  }

  // ── Tasks ──
  for (const t of snapshot.tasks ?? []) {
    const jobId = jobFor(t.job_ref, "tasks");
    if (jobId === null) continue;
    const existing = await db.get<{ id: number }>(
      "SELECT id FROM tasks WHERE org_id = ? AND job_id = ? AND lower(title) = ?",
      orgId, jobId, t.title.trim().toLowerCase(),
    );
    if (existing) {
      report.tasks.existing++;
      continue;
    }
    await db.run(
      "INSERT INTO tasks (org_id, job_id, title, due_on, done) VALUES (?,?,?,?,?)",
      orgId, jobId, t.title.trim(), t.due_on ?? null, t.done ? 1 : 0,
    );
    report.tasks.inserted++;
  }

  // ── Events ──
  for (const e of snapshot.events ?? []) {
    const jobId = jobFor(e.job_ref, "events");
    if (jobId === null) continue;
    const existing = await db.get<{ id: number }>(
      "SELECT id FROM job_events WHERE org_id = ? AND job_id = ? AND kind = ? AND body = ? AND actor = ?",
      orgId, jobId, e.kind, e.body, e.actor,
    );
    if (existing) {
      report.events.existing++;
      continue;
    }
    await db.run(
      "INSERT INTO job_events (org_id, job_id, kind, body, actor, direction, created_at) VALUES (?,?,?,?,?,?, COALESCE(?, datetime('now')))",
      orgId, jobId, e.kind, e.body, e.actor, e.direction ?? "internal", e.created_at ?? null,
    );
    report.events.inserted++;
  }

  return report;
}

async function main() {
  const args = process.argv.slice(2);
  const orgFlag = args.indexOf("--org");
  const file = args.find((a, i) => !a.startsWith("--") && i !== orgFlag + 1);
  const orgId = orgFlag >= 0 ? args[orgFlag + 1] : undefined;
  if (!file || !orgId) {
    console.error("usage: node scripts/import-snapshot.ts <snapshot.json> --org <org uuid>");
    process.exit(2);
  }
  const snapshot = JSON.parse(await readFile(file, "utf8")) as Snapshot;
  console.log(`importing ${file} into org ${orgId} (${process.env.DATABASE_URL ? "postgres" : "sqlite demo"})`);
  const report = await importSnapshot(orgId, snapshot);
  for (const [table, c] of Object.entries(report)) {
    console.log(
      `  ${table.padEnd(9)} inserted=${c.inserted} existing=${c.existing} skipped_demo=${c.skippedDemo} skipped_dangling=${c.skippedDangling}`,
    );
  }
  await closeDb();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
