// What the signing flow tells AMOS: domain events for the tenant's
// automations (proposal.sent / viewed / signed / declined / voided) and the
// transactional emails that move a signature along. Everything is queued in
// the AMOS outbox (lib/amos-outbox.ts) and delivered by the worker, so a
// platform hiccup delays a message but never loses it. Orgs not linked to
// AMOS (the sqlite demo) queue nothing.
import type { Db } from "./db.ts";
import { enqueue } from "./amos-outbox.ts";
import { getEnvelope, getSigners, snapshotModel, type EnvelopeRow } from "./esign.ts";
import { money, type RenderModel } from "./proposal-model.ts";

async function amosOrg(db: Db, orgId: string): Promise<string | null> {
  return (await db.get<{ a: string | null }>("SELECT amos_tenant_id AS a FROM orgs WHERE id = ?", orgId))?.a ?? null;
}

interface Ctx {
  db: Db;
  orgId: string;
  amosOrgId: string;
  env: EnvelopeRow;
  model: RenderModel;
  origin: string;
}

async function ctx(db: Db, orgId: string, envelopeId: number, origin: string): Promise<Ctx | null> {
  const amosOrgId = await amosOrg(db, orgId);
  if (!amosOrgId) return null;
  const env = await getEnvelope(db, orgId, envelopeId);
  if (!env) return null;
  return { db, orgId, amosOrgId, env, model: snapshotModel(env), origin: origin.replace(/\/$/, "") };
}

function eventData(c: Ctx, extra: Record<string, unknown> = {}) {
  return {
    proposal_id: Number(c.env.proposal_id),
    job_id: Number(c.env.job_id),
    envelope_id: Number(c.env.id),
    proposal_name: c.model.proposal.name,
    total_cents: c.model.total_cents,
    customer: { name: c.model.customer.name, email: c.model.customer.email || null, address: c.model.customer.address },
    rep: { name: c.model.rep.name, email: c.model.rep.email || null },
    url: `${c.origin}/proposals/${c.env.proposal_id}`,
    ...extra,
  };
}

async function event(c: Ctx, topic: string, key: string, extra: Record<string, unknown> = {}) {
  await enqueue(c.db, c.orgId, "event", topic, key, {
    kind: "event",
    idempotency_key: key,
    org_id: c.amosOrgId,
    topic,
    occurred_at: new Date().toISOString(),
    data: eventData(c, extra),
  });
}

async function email(
  c: Ctx,
  topic: string,
  key: string,
  to: string | null | undefined,
  subject: string,
  text: string,
  cta: { label: string; url: string } | null,
  replyTo: string | null | undefined,
) {
  if (!to) return;
  await enqueue(c.db, c.orgId, "email", topic, key, {
    kind: "email",
    idempotency_key: key,
    org_id: c.amosOrgId,
    topic,
    to: [{ email: to }],
    subject,
    text,
    cta,
    reply_to: replyTo || null,
  });
}

const first = (name: string) => name.trim().split(/\s+/)[0] || "there";

/** Sent (or a new link issued): event + the signing-request email. */
export async function notifySent(db: Db, orgId: string, envelopeId: number, token: string, origin: string, reissue = false) {
  const c = await ctx(db, orgId, envelopeId, origin);
  if (!c) return;
  const m = c.model;
  const company = m.branding.company_name || m.rep.company;
  // The link's own hash prefix keys the email, so a reissued link is a new
  // message and a double-submitted send is not.
  const linkKey = token.slice(0, 12);
  if (!reissue) await event(c, "proposal.sent", `env-${c.env.id}-sent`);
  await email(
    c,
    "proposal.signature_request",
    `env-${c.env.id}-request-${linkKey}`,
    m.customer.email,
    `Your proposal from ${company} is ready to sign`,
    [
      `Hi ${first(m.customer.name)},`,
      "",
      `${m.rep.name || company} sent you a proposal for ${m.customer.address || "your project"} (${money(m.total_cents)}).`,
      "",
      "You can review every page, including product details and terms, and sign from your computer or phone. It takes about two minutes.",
      "",
      "This link is personal to you and stays active for 30 days. Questions? Just reply to this email.",
    ].join("\n"),
    { label: "Review & sign", url: `${c.origin}/sign/${encodeURIComponent(token)}` },
    m.rep.email,
  );
}

export async function notifyViewed(db: Db, orgId: string, envelopeId: number, origin: string) {
  const c = await ctx(db, orgId, envelopeId, origin);
  if (c) await event(c, "proposal.viewed", `env-${c.env.id}-viewed`);
}

/** Customer signed, contractor still to countersign: nudge the rep. */
export async function notifyCustomerSigned(db: Db, orgId: string, envelopeId: number, origin: string) {
  const c = await ctx(db, orgId, envelopeId, origin);
  if (!c) return;
  await event(c, "proposal.customer_signed", `env-${c.env.id}-customer-signed`);
  const contractor = (await getSigners(db, orgId, Number(c.env.id))).find((s) => s.role === "contractor");
  if (!contractor || contractor.status === "Signed") return;
  await email(
    c,
    "proposal.countersign_request",
    `env-${c.env.id}-countersign`,
    contractor.email,
    `${c.model.customer.name} signed — countersign to finish`,
    `${c.model.customer.name} signed "${c.model.proposal.name}" (${money(c.model.total_cents)}). Countersign in Roofline to complete it and file the signed copy on the job.`,
    { label: "Open proposal", url: `${c.origin}/proposals/${c.env.proposal_id}` },
    null,
  );
}

/** Everyone signed: event + signed-copy emails to the customer and the rep. */
export async function notifyCompleted(db: Db, orgId: string, envelopeId: number, downloadToken: string | null, origin: string) {
  const c = await ctx(db, orgId, envelopeId, origin);
  if (!c) return;
  const m = c.model;
  const company = m.branding.company_name || m.rep.company;
  await event(c, "proposal.signed", `env-${c.env.id}-signed`, { final_sha256: c.env.final_sha256 });
  if (downloadToken) {
    await email(
      c,
      "proposal.signed_copy",
      `env-${c.env.id}-signed-copy`,
      m.customer.email,
      `Your signed proposal from ${company}`,
      [
        `Hi ${first(m.customer.name)},`,
        "",
        `Thank you — your proposal with ${company} is signed by both parties. Your copy, with the signature certificate, is ready to download.`,
        "",
        `${m.rep.name || company} will be in touch about next steps.`,
      ].join("\n"),
      { label: "Download signed copy", url: `${c.origin}/sign/${encodeURIComponent(downloadToken)}` },
      m.rep.email,
    );
  }
  await email(
    c,
    "proposal.completed",
    `env-${c.env.id}-completed-rep`,
    m.rep.email,
    `Signed: ${m.proposal.name}`,
    `${m.customer.name} and ${m.rep.name || company} have both signed "${m.proposal.name}" (${money(m.total_cents)}). The signed PDF is filed on the job, the deposit invoice is drafted, and the job moved to Approved.`,
    { label: "Open proposal", url: `${c.origin}/proposals/${c.env.proposal_id}` },
    null,
  );
}

export async function notifyDeclined(db: Db, orgId: string, envelopeId: number, reason: string, origin: string) {
  const c = await ctx(db, orgId, envelopeId, origin);
  if (!c) return;
  await event(c, "proposal.declined", `env-${c.env.id}-declined`, { reason: reason || null });
  await email(
    c,
    "proposal.declined",
    `env-${c.env.id}-declined-rep`,
    c.model.rep.email,
    `${c.model.customer.name} declined ${c.model.proposal.name}`,
    `${c.model.customer.name} declined "${c.model.proposal.name}" (${money(c.model.total_cents)}).${reason ? `\n\nTheir note: "${reason}"` : ""}`,
    { label: "Open proposal", url: `${c.origin}/proposals/${c.env.proposal_id}` },
    null,
  );
}

export async function notifyVoided(db: Db, orgId: string, envelopeId: number, origin: string) {
  const c = await ctx(db, orgId, envelopeId, origin);
  if (c) await event(c, "proposal.voided", `env-${c.env.id}-voided`);
}

/** Delivery state of this envelope's emails, for the proposal page. */
export async function emailStatus(db: Db, orgId: string, envelopeId: number) {
  return db.all<{ topic: string; status: string; attempts: number; last_error: string | null; created_at: string; delivered_at: string | null }>(
    `SELECT topic, status, attempts, last_error, created_at, delivered_at FROM amos_outbox
     WHERE org_id = ? AND kind = 'email' AND idempotency_key LIKE ? ORDER BY id`,
    orgId, `env-${envelopeId}-%`,
  );
}
