"use server";

// In-app proposal editing and the sender's side of e-signature. Every
// action is org-scoped by the session user; line edits are refused once a
// proposal is out for signature (void first) or signed.
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getDb } from "./db";
import { currentUser, type User } from "./auth";
import { clientInfo } from "./client-info";
import { loadProposalModel, getProposal } from "./proposal-data";
import { applyProposalSigned, logJobEvent, recalcProposal } from "./proposal-effects";
import { requestOrigin } from "./request-origin";
import * as ops from "./proposal-ops";
import { createProposalFromMeasurement } from "./actions";
import { notifyCompleted, notifySent, notifyVoided } from "./esign-notify";
import { kickAmosOutbox } from "./amos-worker";
import {
  ACTIVE,
  issueDownloadLink,
  countersign,
  createEnvelope,
  decodeSignaturePng,
  latestEnvelope,
  reissueCustomerLink,
  SignError,
  voidEnvelope,
} from "./esign";

async function requireUser(): Promise<User> {
  const user = await currentUser();
  if (!user) redirect("/login");
  return user;
}

const page = (id: number, q = "") => `/proposals/${id}${q ? `?${q}` : ""}`;
const err = (id: number, message: string) => redirect(page(id, `error=${encodeURIComponent(message)}`));

/** Proposal in this org that may still be edited. */
async function editable(user: User, proposalId: number) {
  const db = getDb();
  const p = await getProposal(db, user.org_id, proposalId);
  if (!p) redirect("/proposals");
  if (p.status === "Signed") err(proposalId, "This proposal is signed and can't be edited.");
  const env = await latestEnvelope(db, user.org_id, proposalId);
  if (env?.status === ACTIVE) err(proposalId, "Void the signature request before editing.");
  return p;
}

async function refreshProposal(id: number) {
  const p = await getDb().get<{ job_id: number }>("SELECT job_id FROM proposals WHERE id = ?", id);
  refresh(id, Number(p?.job_id ?? 0));
}

function refresh(id: number, jobId: number) {
  revalidatePath(page(id));
  revalidatePath("/proposals");
  revalidatePath(`/jobs/${jobId}`);
}

const num = (v: FormDataEntryValue | null, dflt = 0) => {
  const n = Number(String(v ?? "").replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : dflt;
};
const text = (v: FormDataEntryValue | null, max: number) => String(v ?? "").trim().slice(0, max);

// ── Proposal + lines ──────────────────────────────────────────────────

export async function createBlankProposal(jobId: number) {
  const user = await requireUser();
  let pid = 0;
  try {
    pid = await ops.createBlankProposal(getDb(), user.org_id, jobId, user);
  } catch (e) {
    if (e instanceof ops.OpError) redirect("/jobs");
    throw e;
  }
  redirect(page(pid));
}

/** "New proposal" from the Proposals page: pick the job, start blank or
 *  from its latest measurement. */
export async function newProposalForJob(formData: FormData) {
  const user = await requireUser();
  const jobId = num(formData.get("job_id"));
  const job = await getDb().get<{ id: number }>("SELECT id FROM jobs WHERE id = ? AND org_id = ?", jobId, user.org_id);
  if (!job) redirect("/proposals?error=" + encodeURIComponent("Pick a job first."));
  if (formData.get("mode") === "measurement") {
    return createProposalFromMeasurement(jobId);
  }
  return createBlankProposal(jobId);
}

export async function updateProposalMeta(proposalId: number, formData: FormData) {
  const user = await requireUser();
  const p = await editable(user, proposalId);
  const db = getDb();
  const templateId = num(formData.get("template_id"));
  const tpl = templateId
    ? await db.get<{ id: number }>("SELECT id FROM templates WHERE id = ? AND org_id = ? AND kind = 'proposal'", templateId, user.org_id)
    : undefined;
  await db.run(
    "UPDATE proposals SET name = ?, template_id = ? WHERE id = ? AND org_id = ?",
    text(formData.get("name"), 160) || p.name, tpl ? Number(tpl.id) : null, proposalId, user.org_id,
  );
  refresh(proposalId, p.job_id);
}

export async function addLine(proposalId: number, formData: FormData) {
  const user = await requireUser();
  const priceField = text(formData.get("price"), 20);
  try {
    await ops.addProposalLine(getDb(), user.org_id, proposalId, {
      sku: text(formData.get("sku"), 60),
      name: text(formData.get("name"), 200),
      section: text(formData.get("section"), 120),
      notes: text(formData.get("notes"), 4000),
      qty: num(formData.get("qty"), 1),
      unit: text(formData.get("unit"), 30),
      unit_price: priceField ? num(priceField) : null,
    });
  } catch (e) {
    if (e instanceof ops.OpError) err(proposalId, e.message);
    throw e;
  }
  refreshProposal(proposalId);
}

export async function updateLine(proposalId: number, lineId: number, formData: FormData) {
  const user = await requireUser();
  try {
    await ops.updateProposalLine(getDb(), user.org_id, proposalId, lineId, {
      section: text(formData.get("section"), 120),
      name: text(formData.get("name"), 200),
      notes: text(formData.get("notes"), 4000),
      qty: num(formData.get("qty")),
      unit: text(formData.get("unit"), 30),
      unit_price: num(formData.get("price")),
    });
  } catch (e) {
    if (e instanceof ops.OpError) err(proposalId, e.message);
    throw e;
  }
  refreshProposal(proposalId);
}

export async function deleteLine(proposalId: number, lineId: number) {
  const user = await requireUser();
  try {
    await ops.removeProposalLine(getDb(), user.org_id, proposalId, lineId);
  } catch (e) {
    if (e instanceof ops.OpError) err(proposalId, e.message);
    throw e;
  }
  refreshProposal(proposalId);
}

export async function moveLine(proposalId: number, lineId: number, dir: -1 | 1) {
  const user = await requireUser();
  const p = await editable(user, proposalId);
  const db = getDb();
  const lines = await db.all<{ id: number }>(
    "SELECT id FROM proposal_lines WHERE proposal_id = ? AND org_id = ? ORDER BY position, id",
    proposalId, user.org_id,
  );
  const ids = lines.map((l) => Number(l.id));
  const i = ids.indexOf(lineId);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= ids.length) return;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  await db.transaction(async (tx) => {
    for (const [pos, id] of ids.entries()) {
      await tx.run("UPDATE proposal_lines SET position = ? WHERE id = ? AND org_id = ?", pos + 1, id, user.org_id);
    }
  });
  refresh(proposalId, p.job_id);
}

// ── Signing (sender side) ─────────────────────────────────────────────

export async function sendForSignature(proposalId: number) {
  const user = await requireUser();
  let link = "";
  try {
    ({ signing_url: link } = await ops.sendProposalForSignature(getDb(), user.org_id, proposalId, user, await requestOrigin()));
  } catch (e) {
    if (e instanceof ops.OpError) err(proposalId, e.message);
    throw e;
  }
  kickAmosOutbox();
  refreshProposal(proposalId);
  // The raw link is shown once, to the sender; only its hash is stored.
  redirect(page(proposalId, `link=${encodeURIComponent(link.split("/sign/")[1] ?? "")}`));
}

async function activeEnvelope(user: User, proposalId: number) {
  const env = await latestEnvelope(getDb(), user.org_id, proposalId);
  if (!env || env.status !== ACTIVE) err(proposalId, "This proposal isn't out for signature.");
  return env!;
}

export async function reissueLink(proposalId: number) {
  const user = await requireUser();
  const env = await activeEnvelope(user, proposalId);
  let token = "";
  try {
    token = await reissueCustomerLink(getDb(), user.org_id, Number(env.id), user);
  } catch (e) {
    if (!(e instanceof SignError)) throw e;
    err(proposalId, e.message);
  }
  await notifySent(getDb(), user.org_id, Number(env.id), token, await requestOrigin(), true);
  kickAmosOutbox();
  redirect(page(proposalId, `link=${encodeURIComponent(token)}`));
}

export async function voidSignature(proposalId: number, formData: FormData) {
  const user = await requireUser();
  const env = await activeEnvelope(user, proposalId);
  await voidEnvelope(getDb(), user.org_id, Number(env.id), user, text(formData.get("reason"), 300));
  await notifyVoided(getDb(), user.org_id, Number(env.id), await requestOrigin());
  kickAmosOutbox();
  refresh(proposalId, env.job_id);
  redirect(page(proposalId));
}

export async function countersignAction(proposalId: number, formData: FormData) {
  const user = await requireUser();
  const env = await activeEnvelope(user, proposalId);
  let message = "";
  let completed = false;
  try {
    const png = await decodeSignaturePng(String(formData.get("signature") ?? ""));
    completed = await countersign(getDb(), user.org_id, Number(env.id), user.id, {
      png,
      method: formData.get("method") === "drawn" ? "drawn" : "typed",
      typedName: String(formData.get("typed_name") ?? ""),
      consented: formData.get("consent") === "yes",
    }, await clientInfo());
  } catch (e) {
    if (!(e instanceof SignError)) throw e;
    message = e.message;
  }
  if (completed) {
    const db = getDb();
    await notifyCompleted(db, user.org_id, Number(env.id), await issueDownloadLink(db, user.org_id, Number(env.id)), await requestOrigin());
    kickAmosOutbox();
  }
  refresh(proposalId, env.job_id);
  if (message) err(proposalId, message);
  redirect(page(proposalId));
}

/** Signed outside Roofline (paper, in person). Same job effects, no envelope. */
export async function markSignedOnPaper(proposalId: number) {
  const user = await requireUser();
  const p = await editable(user, proposalId);
  const db = getDb();
  await recalcProposal(db, user.org_id, proposalId);
  await applyProposalSigned(db, user.org_id, proposalId, `${user.name} (signed on paper)`);
  refresh(proposalId, p.job_id);
}
