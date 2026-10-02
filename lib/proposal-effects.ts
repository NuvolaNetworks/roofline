// What a proposal state change does to the rest of the job, callable from
// the in-app actions AND the public signing page (which has no session —
// the actor is the signer). No Next imports; callers revalidate.
import type { Db } from "./db.ts";

export async function logJobEvent(
  db: Db,
  orgId: string,
  jobId: number,
  kind: string,
  body: string,
  actor: string,
  direction = "internal",
): Promise<void> {
  await db.run(
    "INSERT INTO job_events (org_id, job_id, kind, body, actor, direction) VALUES (?,?,?,?,?,?)",
    orgId, jobId, kind, body, actor, direction,
  );
  await db.run("UPDATE jobs SET updated_at = datetime('now') WHERE id = ? AND org_id = ?", jobId, orgId);
}

/** Recompute the stored totals from the lines (after any line edit). */
export async function recalcProposal(db: Db, orgId: string, proposalId: number): Promise<void> {
  const t = await db.get<{ total: number; cost: number }>(
    `SELECT COALESCE(SUM(ROUND(qty * unit_price_cents)),0) AS total,
            COALESCE(SUM(ROUND(qty * unit_cost_cents)),0) AS cost
     FROM proposal_lines WHERE proposal_id = ? AND org_id = ?`,
    proposalId, orgId,
  );
  await db.run(
    "UPDATE proposals SET total_cents = ?, cost_cents = ? WHERE id = ? AND org_id = ?",
    Math.round(Number(t?.total ?? 0)), Math.round(Number(t?.cost ?? 0)), proposalId, orgId,
  );
}

/** A signed proposal is the job's value: set it, draft the 50% deposit
 *  invoice, and move the job to Approved. Idempotent per proposal — a
 *  second call on an already-Signed proposal does nothing. */
export async function applyProposalSigned(db: Db, orgId: string, proposalId: number, actor: string): Promise<boolean> {
  const p = await db.get<{ job_id: number; total_cents: number; cost_cents: number; status: string }>(
    "SELECT job_id, total_cents, cost_cents, status FROM proposals WHERE id = ? AND org_id = ?",
    proposalId, orgId,
  );
  if (!p) return false;
  const res = await db.run(
    "UPDATE proposals SET status = 'Signed', signed_at = datetime('now') WHERE id = ? AND org_id = ? AND status != 'Signed'",
    proposalId, orgId,
  );
  if (res.changes === 0) return false;
  await db.run(
    "UPDATE jobs SET value_cents = ?, cost_cents = ? WHERE id = ? AND org_id = ?",
    p.total_cents, p.cost_cents, p.job_id, orgId,
  );
  await logJobEvent(db, orgId, p.job_id, "stage", "Proposal signed", actor);
  // The 50% deposit, drafted ready to send (lib/invoices.ts sends it). Not
  // duplicated if this proposal already has invoices.
  const existing = await db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM invoices WHERE proposal_id = ? AND org_id = ? AND status != 'Void'",
    proposalId, orgId,
  );
  if (Number(existing?.n ?? 0) === 0) {
    const inv = await db.run(
      `INSERT INTO invoices (org_id, job_id, proposal_id, kind, title, percent, amount_cents, status, due_on)
       VALUES (?,?,?, 'Deposit', '50% deposit', 50, ?, 'Draft', date('now','+3 days'))`,
      orgId, p.job_id, proposalId, Math.round(Number(p.total_cents) / 2),
    );
    await db.run("UPDATE invoices SET number = ? WHERE id = ? AND org_id = ?", `INV-${String(inv.lastId).padStart(5, "0")}`, inv.lastId, orgId);
    await logJobEvent(db, orgId, p.job_id, "system", "50% deposit invoice drafted — ready to send", actor);
  }
  await db.run(
    "UPDATE jobs SET stage = 'Approved', stage_since = datetime('now'), updated_at = datetime('now') WHERE id = ? AND org_id = ?",
    p.job_id, orgId,
  );
  await logJobEvent(db, orgId, p.job_id, "stage", "Moved to Approved", actor);
  return true;
}
