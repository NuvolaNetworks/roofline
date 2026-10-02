// Proposal operations shared by the web app (server actions) and the AI
// tool surface (/api/tools/*): create, edit lines, send for signature,
// void, and a full read. No Next imports — callers own sessions, redirects
// and revalidation; failures throw OpError with a message for a person.
import type { Db } from "./db.ts";
import { logJobEvent, recalcProposal } from "./proposal-effects.ts";
import { getLines, getProposal, loadProposalModel } from "./proposal-data.ts";
import { ACTIVE, createEnvelope, getSigners, latestEnvelope, SignError, voidEnvelope } from "./esign.ts";
import { notifySent, notifyVoided } from "./esign-notify.ts";
import { proposalBilling } from "./invoices.ts";
import { lineAmount } from "./proposal-model.ts";

export class OpError extends Error {}

export interface Actor {
  id: number | null;
  name: string;
  email: string;
}

async function job(db: Db, orgId: string, jobId: number) {
  const j = await db.get<{ id: number; title: string }>("SELECT id, title FROM jobs WHERE id = ? AND org_id = ?", jobId, orgId);
  if (!j) throw new OpError("Job not found.");
  return j;
}

export async function createBlankProposal(db: Db, orgId: string, jobId: number, actor: Actor, name?: string): Promise<number> {
  const j = await job(db, orgId, jobId);
  const p = await db.run(
    "INSERT INTO proposals (org_id, job_id, name, status) VALUES (?,?,?, 'Draft')",
    orgId, jobId, (name?.trim() || `Proposal — ${j.title}`).slice(0, 160),
  );
  await logJobEvent(db, orgId, jobId, "system", "Blank proposal created", actor.name);
  return p.lastId;
}

/** Build a proposal from the job's newest measurement: squares × waste →
 *  material quantities, plus labor and disposal, priced from the catalog. */
export async function buildProposalFromMeasurement(db: Db, orgId: string, jobId: number, actor: Actor): Promise<number> {
  await job(db, orgId, jobId);
  const m = await db.get<Record<string, number>>(
    "SELECT * FROM measurements WHERE job_id = ? AND org_id = ? AND status = 'delivered' ORDER BY id DESC LIMIT 1",
    jobId, orgId,
  );
  const squares = Number(m?.total_squares ?? 0) || 25;
  const waste = 1 + Number(m?.waste_pct ?? 12) / 100;
  const withWaste = Math.round(squares * waste * 10) / 10;
  const ridge = Number(m?.ridge_ft ?? 0) + Number(m?.hip_ft ?? 0);
  const eaveRake = Number(m?.eave_ft ?? 0) + Number(m?.rake_ft ?? 0);
  const cat = new Map(
    (
      await db.all<Record<string, string | number>>(
        "SELECT sku, name, unit, price_cents, cost_cents, section FROM catalogue WHERE org_id = ?",
        orgId,
      )
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
  const proposal = await db.run(
    "INSERT INTO proposals (org_id, job_id, name, status) VALUES (?,?,?, 'Draft')",
    orgId, jobId, `Roof replacement — ${squares} sq`,
  );
  const pid = proposal.lastId;
  let position = 0;
  for (const [sku, qty] of plan) {
    const item = cat.get(sku);
    if (!item) continue;
    // The catalog item's own section wins; otherwise labor and disposal
    // group apart from materials.
    const section = String(item.section ?? "") || (/^(LAB|DUMP)-/.test(sku) ? "Labor & Disposal" : "Materials");
    await db.run(
      "INSERT INTO proposal_lines (org_id, proposal_id, sku, name, unit, qty, unit_price_cents, unit_cost_cents, section, position) VALUES (?,?,?,?,?,?,?,?,?,?)",
      orgId, pid, sku, String(item.name), String(item.unit), qty, Number(item.price_cents), Number(item.cost_cents), section, ++position,
    );
  }
  await recalcProposal(db, orgId, pid);
  await logJobEvent(
    db, orgId, jobId, "system",
    `Proposal drafted from measurement (${squares} sq, ${Math.round((waste - 1) * 100)}% waste)`,
    actor.name,
  );
  return pid;
}

/** The proposal, if it may still be edited (not signed, not out for signature). */
export async function editableProposal(db: Db, orgId: string, proposalId: number) {
  const p = await getProposal(db, orgId, proposalId);
  if (!p) throw new OpError("Proposal not found.");
  if (p.status === "Signed") throw new OpError("This proposal is signed and can't be edited.");
  const env = await latestEnvelope(db, orgId, proposalId);
  if (env?.status === ACTIVE) throw new OpError("Void the signature request before editing.");
  return p;
}

export interface LineInput {
  sku?: string;
  name?: string;
  section?: string;
  notes?: string;
  qty?: number;
  unit?: string;
  /** Dollars; omitted = the catalog price. */
  unit_price?: number | null;
}

export async function addProposalLine(db: Db, orgId: string, proposalId: number, input: LineInput): Promise<number> {
  await editableProposal(db, orgId, proposalId);
  const sku = (input.sku ?? "").trim().slice(0, 60);
  const item = sku
    ? await db.get<{ sku: string; name: string; unit: string; price_cents: number; cost_cents: number; section: string }>(
        "SELECT sku, name, unit, price_cents, cost_cents, section FROM catalogue WHERE org_id = ? AND sku = ?",
        orgId, sku,
      )
    : undefined;
  if (sku && !item) throw new OpError(`No catalog item with SKU ${sku}.`);
  const name = (input.name ?? "").trim().slice(0, 200) || item?.name || "";
  if (!name) throw new OpError("Pick a catalog item (sku) or give the item a name.");
  const pos = await db.get<{ m: number }>("SELECT COALESCE(MAX(position), 0) AS m FROM proposal_lines WHERE proposal_id = ? AND org_id = ?", proposalId, orgId);
  const r = await db.run(
    `INSERT INTO proposal_lines (org_id, proposal_id, sku, name, unit, qty, unit_price_cents, unit_cost_cents, section, notes, position)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    orgId, proposalId,
    item?.sku ?? "CUSTOM", name,
    (input.unit ?? "").trim().slice(0, 30) || item?.unit || "each",
    Math.max(0, Number.isFinite(input.qty) ? Number(input.qty) : 1),
    input.unit_price !== undefined && input.unit_price !== null && Number.isFinite(input.unit_price)
      ? Math.round(Math.max(0, input.unit_price) * 100)
      : Number(item?.price_cents ?? 0),
    Number(item?.cost_cents ?? 0),
    (input.section ?? "").trim().slice(0, 120) || item?.section || "",
    (input.notes ?? "").slice(0, 4000),
    Number(pos?.m ?? 0) + 1,
  );
  await recalcProposal(db, orgId, proposalId);
  return r.lastId;
}

/** Update a line; only the fields given change. */
export async function updateProposalLine(db: Db, orgId: string, proposalId: number, lineId: number, input: LineInput): Promise<void> {
  await editableProposal(db, orgId, proposalId);
  const line = await db.get<{ id: number; section: string; name: string; notes: string; qty: number; unit: string; unit_price_cents: number }>(
    "SELECT id, section, name, notes, qty, unit, unit_price_cents FROM proposal_lines WHERE id = ? AND proposal_id = ? AND org_id = ?",
    lineId, proposalId, orgId,
  );
  if (!line) throw new OpError("Line not found on this proposal.");
  await db.run(
    `UPDATE proposal_lines SET section = ?, name = ?, notes = ?, qty = ?, unit = ?, unit_price_cents = ?
     WHERE id = ? AND proposal_id = ? AND org_id = ?`,
    input.section !== undefined ? input.section.trim().slice(0, 120) : line.section,
    input.name !== undefined ? input.name.trim().slice(0, 200) || line.name : line.name,
    input.notes !== undefined ? input.notes.slice(0, 4000) : line.notes,
    input.qty !== undefined && Number.isFinite(input.qty) ? Math.max(0, Number(input.qty)) : Number(line.qty),
    input.unit !== undefined ? input.unit.trim().slice(0, 30) || line.unit : line.unit,
    input.unit_price !== undefined && input.unit_price !== null && Number.isFinite(input.unit_price)
      ? Math.round(Math.max(0, input.unit_price) * 100)
      : Number(line.unit_price_cents),
    lineId, proposalId, orgId,
  );
  await recalcProposal(db, orgId, proposalId);
}

export async function removeProposalLine(db: Db, orgId: string, proposalId: number, lineId: number): Promise<void> {
  await editableProposal(db, orgId, proposalId);
  const r = await db.run("DELETE FROM proposal_lines WHERE id = ? AND proposal_id = ? AND org_id = ?", lineId, proposalId, orgId);
  if (!r.changes) throw new OpError("Line not found on this proposal.");
  await recalcProposal(db, orgId, proposalId);
}

/** Freeze, create the signature envelope, and queue the signing email.
 *  Returns the one-time signing link (null origin → path only). */
export async function sendProposalForSignature(db: Db, orgId: string, proposalId: number, sender: Actor, origin: string) {
  const p = await editableProposal(db, orgId, proposalId);
  const loaded = await loadProposalModel(db, orgId, proposalId, { id: sender.id ?? 0, name: sender.name, email: sender.email });
  if (!loaded) throw new OpError("Proposal not found.");
  if (!loaded.lines.length) throw new OpError("Add at least one line item before sending.");
  try {
    const { envelopeId, token } = await createEnvelope(db, orgId, proposalId, p.job_id, loaded.model, { id: sender.id ?? 0, name: sender.name }, loaded.rep);
    await notifySent(db, orgId, envelopeId, token, origin);
    return {
      envelope_id: envelopeId,
      signing_url: `${origin.replace(/\/$/, "")}/sign/${encodeURIComponent(token)}`,
      emailed_to: loaded.model.customer.email || null,
    };
  } catch (e) {
    if (e instanceof SignError) throw new OpError(e.message);
    throw e;
  }
}

export async function voidSignatureRequest(db: Db, orgId: string, proposalId: number, actor: Actor, reason: string, origin: string) {
  const env = await latestEnvelope(db, orgId, proposalId);
  if (!env || env.status !== ACTIVE) throw new OpError("This proposal isn't out for signature.");
  try {
    await voidEnvelope(db, orgId, Number(env.id), { id: actor.id ?? 0, name: actor.name }, reason);
  } catch (e) {
    if (e instanceof SignError) throw new OpError(e.message);
    throw e;
  }
  await notifyVoided(db, orgId, Number(env.id), origin);
}

/** Everything about one proposal an assistant needs: lines, totals,
 *  signing state, and billing. */
export async function proposalDetail(db: Db, orgId: string, proposalId: number) {
  const p = await getProposal(db, orgId, proposalId);
  if (!p) throw new OpError("Proposal not found.");
  const lines = await getLines(db, orgId, proposalId);
  const env = await latestEnvelope(db, orgId, proposalId);
  const signers = env ? await getSigners(db, orgId, Number(env.id)) : [];
  const billing = await proposalBilling(db, orgId, proposalId);
  const total = lines.reduce((s, l) => s + lineAmount({ qty: Number(l.qty), unit_price_cents: Number(l.unit_price_cents) }), 0);
  return {
    id: Number(p.id),
    job_id: Number(p.job_id),
    job: p.job_title,
    name: p.name,
    status: p.status,
    customer: { name: p.contact_name, email: p.contact_email, phone: p.contact_phone, address: p.address },
    total_cents: total,
    lines: lines.map((l) => ({
      line_id: Number(l.id),
      sku: l.sku,
      section: l.section,
      name: l.name,
      notes: l.notes,
      qty: Number(l.qty),
      unit: l.unit,
      unit_price_cents: Number(l.unit_price_cents),
      amount_cents: lineAmount({ qty: Number(l.qty), unit_price_cents: Number(l.unit_price_cents) }),
    })),
    signature: env
      ? {
          envelope_id: Number(env.id),
          status: env.status,
          document_sha256: env.snapshot_sha256,
          signers: signers.map((s) => ({ role: s.role, name: s.name, status: s.status, viewed_at: s.viewed_at, signed_at: s.signed_at, declined_reason: s.decline_reason })),
        }
      : null,
    billing,
    editable: p.status !== "Signed" && env?.status !== ACTIVE,
    pdf_path: `/proposals/${p.id}/pdf`,
  };
}
