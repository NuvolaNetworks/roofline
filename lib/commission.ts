// Commission tracking, 8 Square's way: on a job, the rep earns
//   (money collected − job costs − overhead% of the contract) × rep share%
// — by default 10% overhead and the profit split 50/50. A job is due once it
// reaches Ready for Commission (every invoice paid); marking it paid records
// the amount and closes the job. On the 1st and 15th each rep is emailed the
// list of jobs they're being paid on, once per period (the statements log's
// unique key is the guard). Statement email goes through the AMOS outbox, so
// orgs not linked to AMOS send nothing.
import type { Db, SqlValue } from "./db.ts";
import { jobMoney } from "./invoices.ts";
import { enqueue } from "./amos-outbox.ts";
import { logJobEvent } from "./proposal-effects.ts";
import { money } from "./proposal-model.ts";

export class CommissionError extends Error {}

export interface CommissionSettings {
  overhead_pct: number;
  rep_share_pct: number;
  statements_enabled: boolean;
}

export const DEFAULT_COMMISSION: CommissionSettings = { overhead_pct: 10, rep_share_pct: 50, statements_enabled: true };

/** Statements go out on these days of the month, in the company's time zone. */
export const STATEMENT_DAYS = [1, 15];
export const COMPANY_TIME_ZONE = "America/Chicago";
/** Where statement links point when ROOFLINE_PUBLIC_URL isn't set (the
 *  background pass has no request to read a host from). */
export const DEFAULT_PUBLIC_URL = "https://roofline.custom.amoslabs.com";

export interface CommissionBreakdown {
  contract_cents: number;
  income_cents: number;
  expenses_cents: number;
  overhead_cents: number;
  profit_cents: number;
  commission_cents: number;
}

/** The formula, pure. A loss pays no commission (never negative). */
export function computeCommission(
  m: { contract_cents: number; collected_cents: number; actual_cost_cents: number },
  s: Pick<CommissionSettings, "overhead_pct" | "rep_share_pct">,
): CommissionBreakdown {
  const overhead = Math.round((m.contract_cents * s.overhead_pct) / 100);
  const profit = m.collected_cents - m.actual_cost_cents - overhead;
  return {
    contract_cents: m.contract_cents,
    income_cents: m.collected_cents,
    expenses_cents: m.actual_cost_cents,
    overhead_cents: overhead,
    profit_cents: profit,
    commission_cents: Math.max(0, Math.round((profit * s.rep_share_pct) / 100)),
  };
}

export async function commissionSettings(db: Db, orgId: string): Promise<CommissionSettings> {
  const r = await db.get<{ o: number | null; s: number | null; e: number | null }>(
    "SELECT commission_overhead_pct AS o, commission_rep_share_pct AS s, commission_statements_enabled AS e FROM orgs WHERE id = ?",
    orgId,
  );
  return {
    overhead_pct: r?.o ?? DEFAULT_COMMISSION.overhead_pct,
    rep_share_pct: r?.s ?? DEFAULT_COMMISSION.rep_share_pct,
    statements_enabled: r?.e === null || r?.e === undefined ? true : Number(r.e) !== 0,
  };
}

export async function saveCommissionSettings(db: Db, orgId: string, s: CommissionSettings): Promise<void> {
  if (!(s.overhead_pct >= 0 && s.overhead_pct <= 100)) throw new CommissionError("Overhead must be between 0 and 100%.");
  if (!(s.rep_share_pct >= 0 && s.rep_share_pct <= 100)) throw new CommissionError("Rep share must be between 0 and 100%.");
  await db.run(
    "UPDATE orgs SET commission_overhead_pct = ?, commission_rep_share_pct = ?, commission_statements_enabled = ? WHERE id = ?",
    s.overhead_pct, s.rep_share_pct, s.statements_enabled ? 1 : 0, orgId,
  );
}

export interface CommissionRow extends CommissionBreakdown {
  job_id: number;
  title: string;
  address: string;
  stage: string;
  rep_id: number | null;
  rep_name: string;
  rep_email: string;
  status: "due" | "paid";
  paid_at: string | null;
  paid_cents: number | null;
}

/** Jobs due (Ready for Commission, unpaid) and/or paid, newest first.
 *  `visible` limits to these reps' jobs (null = the whole org). */
export async function commissionRows(
  db: Db,
  orgId: string,
  opts: { visible: number[] | null; status?: "due" | "paid" | "all"; repId?: number; paidSince?: string },
): Promise<CommissionRow[]> {
  const status = opts.status ?? "due";
  const where: string[] = ["j.org_id = ?"];
  const params: SqlValue[] = [orgId];
  if (status === "due") where.push("j.stage = 'Ready for Commission' AND j.commission_paid_at IS NULL");
  else if (status === "paid") where.push("j.commission_paid_at IS NOT NULL");
  else where.push("(j.commission_paid_at IS NOT NULL OR j.stage = 'Ready for Commission')");
  if (opts.paidSince) {
    where.push("(j.commission_paid_at IS NULL OR j.commission_paid_at >= ?)");
    params.push(opts.paidSince);
  }
  if (opts.repId) {
    where.push("j.assignee_id = ?");
    params.push(opts.repId);
  }
  if (opts.visible !== null) {
    if (opts.visible.length === 0) return [];
    where.push(`j.assignee_id IN (${opts.visible.map(() => "?").join(",")})`);
    params.push(...opts.visible);
  }
  const jobs = await db.all<{
    id: number; title: string; address: string; stage: string; assignee_id: number | null;
    rep_name: string | null; rep_email: string | null; commission_paid_at: string | null; commission_paid_cents: number | null;
  }>(
    `SELECT j.id, j.title, j.address, j.stage, j.assignee_id, u.name AS rep_name, u.email AS rep_email,
            j.commission_paid_at, j.commission_paid_cents
       FROM jobs j LEFT JOIN users u ON u.id = j.assignee_id
      WHERE ${where.join(" AND ")}
      ORDER BY COALESCE(j.commission_paid_at, j.stage_since) DESC, j.id DESC`,
    ...params,
  );
  const settings = await commissionSettings(db, orgId);
  const rows: CommissionRow[] = [];
  for (const j of jobs) {
    const m = await jobMoney(db, orgId, Number(j.id));
    rows.push({
      job_id: Number(j.id),
      title: j.title,
      address: j.address,
      stage: j.stage,
      rep_id: j.assignee_id === null ? null : Number(j.assignee_id),
      rep_name: j.rep_name ?? "Unassigned",
      rep_email: j.rep_email ?? "",
      status: j.commission_paid_at ? "paid" : "due",
      paid_at: j.commission_paid_at,
      paid_cents: j.commission_paid_cents === null ? null : Number(j.commission_paid_cents),
      ...computeCommission(m, settings),
    });
  }
  return rows;
}

/** Record the payout at today's numbers and close the job. */
export async function markCommissionPaid(
  db: Db,
  orgId: string,
  jobId: number,
  actor: { id: number | null; name: string },
): Promise<CommissionRow> {
  const [row] = await commissionRows(db, orgId, { visible: null, status: "all" }).then((rows) => rows.filter((r) => r.job_id === jobId));
  if (!row) throw new CommissionError("Only a job that's Ready for Commission can be paid out.");
  if (row.status === "paid") throw new CommissionError("This commission was already paid.");
  await db.run(
    `UPDATE jobs SET commission_paid_at = datetime('now'), commission_paid_cents = ?, commission_paid_by = ?,
            stage = 'Closed', stage_since = datetime('now'), updated_at = datetime('now')
      WHERE id = ? AND org_id = ? AND commission_paid_at IS NULL`,
    row.commission_cents, actor.id, jobId, orgId,
  );
  await logJobEvent(db, orgId, jobId, "system", `Commission paid to ${row.rep_name}: ${money(row.commission_cents)} — job closed`, actor.name);
  return { ...row, status: "paid", paid_cents: row.commission_cents };
}

/** YYYY-MM-DD in the company's time zone. */
export function companyDate(now: Date, timeZone = COMPANY_TIME_ZONE): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export function isStatementDay(date: string): boolean {
  return STATEMENT_DAYS.includes(Number(date.slice(8, 10)));
}

function statementText(name: string, period: string, company: string, rows: CommissionRow[], s: CommissionSettings): string {
  const total = rows.reduce((t, r) => t + r.commission_cents, 0);
  const lines = rows.map(
    (r) =>
      `• ${r.title}${r.address ? ` (${r.address})` : ""}\n    collected ${money(r.income_cents)} − costs ${money(r.expenses_cents)} − ${s.overhead_pct}% overhead ${money(r.overhead_cents)} = profit ${money(r.profit_cents)} → your ${s.rep_share_pct}%: ${money(r.commission_cents)}`,
  );
  return [
    `Hi ${name.trim().split(/\s+/)[0] || "there"},`,
    "",
    `Here's your ${company} commission statement for ${period}: ${money(total)} on ${rows.length} job${rows.length === 1 ? "" : "s"} ready for payout.`,
    "",
    ...lines,
    "",
    `Commission = (collected − job costs − ${s.overhead_pct}% of the contract for overhead) × ${s.rep_share_pct}%.`,
    "Questions about a job? Reply to this email.",
  ].join("\n");
}

/** Queue one statement per rep with jobs due, at most once per rep per
 *  period. Returns how many were queued. `force` sends on a non-statement
 *  day (the "send now" button), under its own period key. */
export async function sendCommissionStatements(
  db: Db,
  orgId: string,
  opts: { now?: Date; origin: string; force?: boolean; replyTo?: string | null },
): Promise<{ period: string | null; queued: number; reps: Array<{ rep: string; jobs: number; total_cents: number }> }> {
  const date = companyDate(opts.now ?? new Date());
  if (!opts.force && !isStatementDay(date)) return { period: null, queued: 0, reps: [] };
  const period = opts.force ? `${date}-manual-${(opts.now ?? new Date()).getTime()}` : date;
  const org = await db.get<{ name: string; amos: string | null }>("SELECT name, amos_tenant_id AS amos FROM orgs WHERE id = ?", orgId);
  if (!org?.amos) return { period, queued: 0, reps: [] };
  const settings = await commissionSettings(db, orgId);
  if (!settings.statements_enabled && !opts.force) return { period, queued: 0, reps: [] };
  const due = await commissionRows(db, orgId, { visible: null, status: "due" });
  const byRep = new Map<number, CommissionRow[]>();
  for (const r of due) {
    if (r.rep_id === null || !r.rep_email) continue;
    byRep.set(r.rep_id, [...(byRep.get(r.rep_id) ?? []), r]);
  }
  const reps: Array<{ rep: string; jobs: number; total_cents: number }> = [];
  let queued = 0;
  for (const [repId, rows] of byRep) {
    const total = rows.reduce((t, r) => t + r.commission_cents, 0);
    const claim = await db.run(
      "INSERT INTO commission_statements (org_id, period, user_id, total_cents, job_count) VALUES (?,?,?,?,?) ON CONFLICT (org_id, period, user_id) DO NOTHING",
      orgId, period, repId, total, rows.length,
    );
    if (claim.changes === 0) continue;
    const key = `commission-${orgId}-${period}-${repId}`;
    const label = opts.force ? date : period;
    await enqueue(db, orgId, "email", "commission.statement", key, {
      kind: "email",
      idempotency_key: key,
      org_id: org.amos,
      topic: "commission.statement",
      to: [{ email: rows[0].rep_email }],
      subject: `Your commission statement for ${label}: ${money(total)} on ${rows.length} job${rows.length === 1 ? "" : "s"}`,
      text: statementText(rows[0].rep_name, label, org.name, rows, settings),
      cta: { label: "View in Roofline", url: `${opts.origin.replace(/\/$/, "")}/commissions` },
      reply_to: opts.replyTo ?? null,
    });
    queued += 1;
    reps.push({ rep: rows[0].rep_name, jobs: rows.length, total_cents: total });
  }
  return { period, queued, reps };
}

/** The worker's twice-a-month pass over every linked org. */
export async function runDueCommissionStatements(db: Db, now = new Date()): Promise<number> {
  const origin = process.env.ROOFLINE_PUBLIC_URL || DEFAULT_PUBLIC_URL;
  if (!isStatementDay(companyDate(now))) return 0;
  const orgs = await db.all<{ id: string }>("SELECT id FROM orgs WHERE amos_tenant_id IS NOT NULL");
  let queued = 0;
  for (const o of orgs) queued += (await sendCommissionStatements(db, o.id, { now, origin })).queued;
  return queued;
}
