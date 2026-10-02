// Native e-signature for proposals.
//
// Sending freezes the proposal: the render model is serialised to canonical
// JSON, hashed (SHA-256), and stored on a signature envelope. Signers sign
// THAT snapshot — later edits to the proposal can't change what was signed
// (editing requires voiding the envelope first). Customers reach the public
// signing page by a random link token (only its hash is stored, it expires);
// the contractor countersigns in-app as their logged-in user. Every view,
// consent, signature, decline and void is appended to envelope_events.
//
// When the last signer signs, the final PDF is rendered from the snapshot
// with the signatures stamped on the summary page plus a signature
// certificate (signers, IPs, devices, timestamps, document fingerprint),
// attachments are verified against their frozen hashes, and the result is
// stored, hashed, filed on the job, and the proposal is marked Signed.
//
// This is the ESIGN/UETA "intent + consent + attribution + integrity"
// pattern used by the roofing CRMs; it is not a PKI digital signature.
import { randomBytes, createHash } from "node:crypto";
import { PDFDocument } from "pdf-lib";
import type { Db } from "./db.ts";
import { putFile, getFile, sha256Hex } from "./files.ts";
import { signerRoles, type RenderModel } from "./proposal-model.ts";
import { renderProposalPdf, type AuditInfo, type SignatureMark } from "./proposal-pdf.ts";
import { applyProposalSigned, logJobEvent, recalcProposal } from "./proposal-effects.ts";
import { fileLoader } from "./proposal-data.ts";

export const TOKEN_TTL_DAYS = 30;
export const MAX_SIGNATURE_BYTES = 512 * 1024;

export const CONSENT_TEXT =
  "I agree to do business electronically, to receive this document electronically, and that my electronic signature is the legal equivalent of my handwritten signature on this document.";

export const ACTIVE = "Out for signature";

export class SignError extends Error {}

// ── Primitives ────────────────────────────────────────────────────────

export function newToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** JSON with object keys sorted at every level — a stable byte string to
 *  hash, independent of property insertion order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(",")}}`;
}

/** Decode and validate a signature image from the pad ("data:image/png;base64,…"). */
export async function decodeSignaturePng(dataUrl: string): Promise<Uint8Array> {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl.trim());
  if (!m) throw new SignError("Please draw or type your signature.");
  const bytes = new Uint8Array(Buffer.from(m[1], "base64"));
  if (bytes.length > MAX_SIGNATURE_BYTES) throw new SignError("That signature image is too large.");
  try {
    const probe = await PDFDocument.create();
    const img = await probe.embedPng(bytes);
    if (img.width < 20 || img.height < 10) throw new Error("tiny");
  } catch {
    throw new SignError("That signature image couldn't be read — please try again.");
  }
  return bytes;
}

// ── Rows ──────────────────────────────────────────────────────────────

export interface EnvelopeRow {
  id: number;
  org_id: string;
  proposal_id: number;
  job_id: number;
  status: string;
  snapshot: string;
  snapshot_sha256: string;
  final_file_id: number | null;
  final_sha256: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface SignerRow {
  id: number;
  envelope_id: number;
  role: "customer" | "contractor";
  name: string;
  email: string | null;
  user_id: number | null;
  token_expires_at: string | null;
  status: string;
  viewed_at: string | null;
  signed_at: string | null;
  signature_file_id: number | null;
  signature_method: string | null;
  consent_text: string | null;
  ip: string | null;
  user_agent: string | null;
  decline_reason: string | null;
}

const SIGNER_COLS =
  "id, envelope_id, role, name, email, user_id, token_expires_at, status, viewed_at, signed_at, signature_file_id, signature_method, consent_text, ip, user_agent, decline_reason";

export interface Client {
  ip: string;
  userAgent: string;
}

async function event(
  db: Db,
  orgId: string,
  envelopeId: number,
  signerId: number | null,
  name: string,
  detail: string,
  client?: Client,
) {
  await db.run(
    "INSERT INTO envelope_events (org_id, envelope_id, signer_id, event, detail, ip, user_agent) VALUES (?,?,?,?,?,?,?)",
    orgId, envelopeId, signerId, name, detail, client?.ip ?? null, client?.userAgent?.slice(0, 400) ?? null,
  );
}

export async function getEnvelope(db: Db, orgId: string, envelopeId: number): Promise<EnvelopeRow | undefined> {
  return db.get<EnvelopeRow>("SELECT * FROM signature_envelopes WHERE id = ? AND org_id = ?", envelopeId, orgId);
}

export async function latestEnvelope(db: Db, orgId: string, proposalId: number): Promise<EnvelopeRow | undefined> {
  return db.get<EnvelopeRow>(
    "SELECT * FROM signature_envelopes WHERE proposal_id = ? AND org_id = ? ORDER BY id DESC LIMIT 1",
    proposalId, orgId,
  );
}

export async function getSigners(db: Db, orgId: string, envelopeId: number): Promise<SignerRow[]> {
  return db.all<SignerRow>(
    `SELECT ${SIGNER_COLS} FROM envelope_signers WHERE envelope_id = ? AND org_id = ? ORDER BY id`,
    envelopeId, orgId,
  );
}

export function snapshotModel(env: Pick<EnvelopeRow, "snapshot">): RenderModel {
  return JSON.parse(env.snapshot) as RenderModel;
}

// ── Sending ───────────────────────────────────────────────────────────

export interface Sender {
  id: number;
  name: string;
}

/** Freeze the proposal into a new envelope and mint the customer's link.
 *  Returns the raw token — shown once to the sender, never stored. */
export async function createEnvelope(
  db: Db,
  orgId: string,
  proposalId: number,
  jobId: number,
  model: RenderModel,
  sender: Sender,
  contractor: { id: number | null; name: string; email: string },
): Promise<{ envelopeId: number; token: string }> {
  if (!model.customer.name.trim()) throw new SignError("Add the customer's name to the job before sending.");
  const snapshot = canonicalJson(model);
  const snapshotSha = sha256Hex(snapshot);
  const { token, hash } = newToken();
  return db.transaction(async (tx) => {
    const active = await tx.get<{ id: number }>(
      "SELECT id FROM signature_envelopes WHERE proposal_id = ? AND org_id = ? AND status = ?",
      proposalId, orgId, ACTIVE,
    );
    if (active) throw new SignError("This proposal is already out for signature — void it first to resend.");
    // Stored totals must match the frozen document: they become the job's
    // value when it's signed.
    await recalcProposal(tx, orgId, proposalId);
    const env = await tx.run(
      "INSERT INTO signature_envelopes (org_id, proposal_id, job_id, status, snapshot, snapshot_sha256, created_by) VALUES (?,?,?,?,?,?,?)",
      orgId, proposalId, jobId, ACTIVE, snapshot, snapshotSha, sender.id,
    );
    const envelopeId = env.lastId;
    await event(tx, orgId, envelopeId, null, "created", `Sent by ${sender.name}; document SHA-256 ${snapshotSha}`);
    for (const s of signerRoles(model)) {
      if (s.role === "customer") {
        const r = await tx.run(
          `INSERT INTO envelope_signers (org_id, envelope_id, role, name, email, token_hash, token_expires_at)
           VALUES (?,?,?,?,?,?, datetime('now', ?))`,
          orgId, envelopeId, "customer", model.customer.name, model.customer.email || null, hash, `+${TOKEN_TTL_DAYS} days`,
        );
        await event(tx, orgId, envelopeId, r.lastId, "sent", `Signing link issued to ${model.customer.name}`);
      } else {
        await tx.run(
          "INSERT INTO envelope_signers (org_id, envelope_id, role, name, email, user_id) VALUES (?,?,?,?,?,?)",
          orgId, envelopeId, "contractor", contractor.name, contractor.email || null, contractor.id,
        );
      }
    }
    await tx.run(
      "UPDATE proposals SET status = 'Sent', sent_at = datetime('now') WHERE id = ? AND org_id = ?",
      proposalId, orgId,
    );
    await logJobEvent(tx, orgId, jobId, "email", "Proposal sent for e-signature", sender.name, "outbound");
    return { envelopeId, token };
  });
}

/** Mint a fresh customer link (the old one stops working). */
export async function reissueCustomerLink(db: Db, orgId: string, envelopeId: number, sender: Sender): Promise<string> {
  const env = await getEnvelope(db, orgId, envelopeId);
  if (!env || env.status !== ACTIVE) throw new SignError("This envelope is no longer out for signature.");
  const { token, hash } = newToken();
  const r = await db.run(
    `UPDATE envelope_signers SET token_hash = ?, token_expires_at = datetime('now', ?)
     WHERE envelope_id = ? AND org_id = ? AND role = 'customer' AND status IN ('Pending','Viewed')`,
    hash, `+${TOKEN_TTL_DAYS} days`, envelopeId, orgId,
  );
  if (r.changes === 0) throw new SignError("The customer has already signed.");
  await event(db, orgId, envelopeId, null, "sent", `New signing link issued by ${sender.name}`);
  return token;
}

export async function voidEnvelope(db: Db, orgId: string, envelopeId: number, sender: Sender, reason: string): Promise<void> {
  const env = await getEnvelope(db, orgId, envelopeId);
  if (!env || env.status !== ACTIVE) throw new SignError("Only an envelope that is out for signature can be voided.");
  await db.run("UPDATE signature_envelopes SET status = 'Voided' WHERE id = ? AND org_id = ? AND status = ?", envelopeId, orgId, ACTIVE);
  await db.run("UPDATE envelope_signers SET token_hash = NULL WHERE envelope_id = ? AND org_id = ?", envelopeId, orgId);
  await event(db, orgId, envelopeId, null, "voided", `${sender.name}: ${reason || "voided to edit"}`);
  await db.run("UPDATE proposals SET status = 'Draft' WHERE id = ? AND org_id = ? AND status != 'Signed'", env.proposal_id, orgId);
  await logJobEvent(db, orgId, env.job_id, "system", "Signature request voided — proposal back to draft", sender.name);
}

// ── Public signing (by token) ─────────────────────────────────────────

export interface SigningSession {
  orgId: string;
  envelope: EnvelopeRow;
  signer: SignerRow;
  model: RenderModel;
  signers: SignerRow[];
}

/** Resolve a link token. Expired, voided, or unknown tokens resolve to
 *  null; completed envelopes still resolve so the customer can download
 *  their signed copy. */
export async function sessionForToken(db: Db, token: string): Promise<SigningSession | null> {
  if (!token || token.length > 100) return null;
  const row = await db.get<SignerRow & { org_id: string }>(
    `SELECT org_id, ${SIGNER_COLS} FROM envelope_signers WHERE token_hash = ?`,
    hashToken(token),
  );
  if (!row) return null;
  const envelope = await getEnvelope(db, row.org_id, Number(row.envelope_id));
  if (!envelope || envelope.status === "Voided") return null;
  const expired = row.token_expires_at !== null && row.token_expires_at < nowText();
  if (expired && envelope.status !== "Completed") return null;
  return {
    orgId: row.org_id,
    envelope,
    signer: row,
    model: snapshotModel(envelope),
    signers: await getSigners(db, row.org_id, envelope.id),
  };
}

function nowText(): string {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

export async function recordView(db: Db, s: SigningSession, client: Client): Promise<void> {
  if (s.envelope.status !== ACTIVE) return;
  const r = await db.run(
    "UPDATE envelope_signers SET status = 'Viewed', viewed_at = datetime('now') WHERE id = ? AND org_id = ? AND status = 'Pending'",
    s.signer.id, s.orgId,
  );
  if (r.changes === 0) return; // only the first view is an event
  await event(db, s.orgId, s.envelope.id, s.signer.id, "viewed", `${s.signer.name} opened the document`, client);
  const p = await db.run(
    "UPDATE proposals SET status = 'Viewed', viewed_at = datetime('now') WHERE id = ? AND org_id = ? AND status = 'Sent'",
    s.envelope.proposal_id, s.orgId,
  );
  if (p.changes) await logJobEvent(db, s.orgId, s.envelope.job_id, "email", `Proposal viewed by ${s.signer.name}`, s.signer.name, "inbound");
}

export interface Signature {
  png: Uint8Array;
  method: "drawn" | "typed";
  typedName: string;
  consented: boolean;
}

async function sign(db: Db, orgId: string, envelope: EnvelopeRow, signer: SignerRow, sig: Signature, client: Client): Promise<boolean> {
  if (envelope.status !== ACTIVE) throw new SignError("This document is no longer awaiting signature.");
  if (signer.status === "Signed") throw new SignError("You've already signed this document.");
  if (signer.status === "Declined") throw new SignError("This signature request was declined.");
  if (!sig.consented) throw new SignError("Please agree to sign electronically.");
  const file = await putFile(db, orgId, "signature", `signature-${envelope.id}-${signer.role}.png`, sig.png, ["image/png"]);
  const r = await db.run(
    `UPDATE envelope_signers SET status = 'Signed', signed_at = datetime('now'), signature_file_id = ?, signature_method = ?,
            typed_name = ?, consent_text = ?, ip = ?, user_agent = ?
     WHERE id = ? AND org_id = ? AND status IN ('Pending','Viewed')`,
    file.id, sig.method, sig.typedName.slice(0, 120) || null, CONSENT_TEXT, client.ip, client.userAgent.slice(0, 400),
    signer.id, orgId,
  );
  if (r.changes === 0) throw new SignError("You've already signed this document.");
  await event(db, orgId, envelope.id, signer.id, "consented", CONSENT_TEXT, client);
  await event(db, orgId, envelope.id, signer.id, "signed", `${signer.name} signed (${sig.method}); signature SHA-256 ${file.sha256}`, client);
  await logJobEvent(db, orgId, envelope.job_id, "stage", `Proposal signed by ${signer.name}`, signer.name, signer.role === "customer" ? "inbound" : "internal");
  return finalizeIfComplete(db, orgId, envelope.id);
}

export async function signByToken(db: Db, s: SigningSession, sig: Signature, client: Client): Promise<boolean> {
  if (s.signer.role !== "customer") throw new SignError("This link can't be used to sign.");
  return sign(db, s.orgId, s.envelope, s.signer, sig, client);
}

/** In-app countersignature by the logged-in contractor signer. */
export async function countersign(db: Db, orgId: string, envelopeId: number, userId: number, sig: Signature, client: Client): Promise<boolean> {
  const envelope = await getEnvelope(db, orgId, envelopeId);
  if (!envelope) throw new SignError("Envelope not found.");
  const signer = (await getSigners(db, orgId, envelopeId)).find((x) => x.role === "contractor");
  if (!signer) throw new SignError("This document has no contractor signature.");
  if (Number(signer.user_id) !== userId) throw new SignError(`Only ${signer.name} can countersign this document.`);
  return sign(db, orgId, envelope, signer, sig, client);
}

export async function declineByToken(db: Db, s: SigningSession, reason: string, client: Client): Promise<void> {
  if (s.envelope.status !== ACTIVE || s.signer.status === "Signed") throw new SignError("This document can no longer be declined.");
  await db.run(
    "UPDATE envelope_signers SET status = 'Declined', decline_reason = ? WHERE id = ? AND org_id = ?",
    reason.slice(0, 1000), s.signer.id, s.orgId,
  );
  await db.run("UPDATE signature_envelopes SET status = 'Declined' WHERE id = ? AND org_id = ? AND status = ?", s.envelope.id, s.orgId, ACTIVE);
  await db.run(
    "UPDATE proposals SET status = 'Declined', declined_at = datetime('now') WHERE id = ? AND org_id = ?",
    s.envelope.proposal_id, s.orgId,
  );
  await event(db, s.orgId, s.envelope.id, s.signer.id, "declined", reason.slice(0, 1000) || "No reason given", client);
  await logJobEvent(
    db, s.orgId, s.envelope.job_id, "email",
    `Proposal declined by ${s.signer.name}${reason ? `: "${reason.slice(0, 200)}"` : ""}`, s.signer.name, "inbound",
  );
}

// ── Rendering + completion ────────────────────────────────────────────

function displayDate(ts: string | null): string {
  if (!ts) return "";
  const [y, m, d] = ts.slice(0, 10).split("-");
  return `${m}/${d}/${y}`;
}

async function signatureMarks(db: Db, orgId: string, signers: SignerRow[]): Promise<SignatureMark[]> {
  const marks: SignatureMark[] = [];
  for (const s of signers) {
    if (s.status !== "Signed" || !s.signature_file_id) continue;
    const f = await getFile(db, orgId, Number(s.signature_file_id));
    if (f) marks.push({ role: s.role, name: s.name, png: f.bytes, date: displayDate(s.signed_at) });
  }
  return marks;
}

async function auditInfo(db: Db, orgId: string, env: EnvelopeRow, signers: SignerRow[], completedAt: string): Promise<AuditInfo> {
  const events = await db.all<{ created_at: string; event: string; ip: string | null; signer: string | null }>(
    `SELECT e.created_at, e.event, e.ip, s.name AS signer FROM envelope_events e
     LEFT JOIN envelope_signers s ON s.id = e.signer_id
     WHERE e.envelope_id = ? AND e.org_id = ? ORDER BY e.id`,
    env.id, orgId,
  );
  return {
    envelope_id: Number(env.id),
    document_sha256: env.snapshot_sha256,
    created_at: env.created_at,
    completed_at: completedAt,
    signers: signers.map((s) => ({
      role: s.role,
      name: s.name,
      email: s.email ?? "",
      method: s.signature_method === "typed" ? "Typed signature (adopted)" : "Drawn signature",
      ip: s.ip ?? "",
      user_agent: s.user_agent ?? "",
      viewed_at: s.viewed_at ?? "",
      signed_at: s.signed_at ?? "",
      consent_text: s.consent_text ?? CONSENT_TEXT,
    })),
    events: events.map((e) => ({ at: e.created_at, event: e.event, who: e.signer ?? "Roofline", ip: e.ip ?? "" })),
  };
}

/** The envelope's document as it stands: frozen snapshot plus whatever
 *  signatures exist so far (preview), or the stored final PDF. */
export async function envelopePdf(db: Db, orgId: string, env: EnvelopeRow): Promise<Uint8Array> {
  if (env.final_file_id) {
    const f = await getFile(db, orgId, Number(env.final_file_id));
    if (f) return f.bytes;
  }
  const signers = await getSigners(db, orgId, env.id);
  return renderProposalPdf(snapshotModel(env), {
    loadFile: fileLoader(db, orgId),
    signatures: await signatureMarks(db, orgId, signers),
  });
}

/** If every signer has signed, render + store the final PDF and complete
 *  the envelope. Safe to call concurrently: only one caller's UPDATE wins
 *  the Out-for-signature → Completed transition. */
export async function finalizeIfComplete(db: Db, orgId: string, envelopeId: number): Promise<boolean> {
  const env = await getEnvelope(db, orgId, envelopeId);
  if (!env || env.status !== ACTIVE) return false;
  const signers = await getSigners(db, orgId, envelopeId);
  if (!signers.length || signers.some((s) => s.status !== "Signed")) return false;

  const completedAt = nowText();
  await event(db, orgId, envelopeId, null, "completed", "All parties signed");
  const pdf = await renderProposalPdf(snapshotModel(env), {
    loadFile: fileLoader(db, orgId),
    signatures: await signatureMarks(db, orgId, signers),
    audit: await auditInfo(db, orgId, env, signers, completedAt),
    strictHashes: true,
  });
  const model = snapshotModel(env);
  const file = await putFile(db, orgId, "signed_pdf", `${model.proposal.name} - signed.pdf`, pdf, ["application/pdf"]);
  const won = await db.run(
    `UPDATE signature_envelopes SET status = 'Completed', completed_at = ?, final_file_id = ?, final_sha256 = ?
     WHERE id = ? AND org_id = ? AND status = ?`,
    completedAt, file.id, file.sha256, envelopeId, orgId, ACTIVE,
  );
  if (won.changes === 0) {
    await db.run("DELETE FROM files WHERE id = ? AND org_id = ?", file.id, orgId);
    return false;
  }
  const customer = signers.find((s) => s.role === "customer");
  await db.run(
    "INSERT INTO documents (org_id, job_id, template_id, name, status, signer, signed_at, file_id, envelope_id) VALUES (?,?,NULL,?, 'Signed', ?, datetime('now'), ?, ?)",
    orgId, env.job_id, `${model.proposal.name} (signed)`, customer?.name ?? null, file.id, envelopeId,
  );
  await applyProposalSigned(db, orgId, Number(env.proposal_id), customer?.name ?? "e-signature");
  await logJobEvent(db, orgId, env.job_id, "system", `Signed proposal filed (SHA-256 ${file.sha256.slice(0, 16)}…)`, "e-signature");
  return true;
}
