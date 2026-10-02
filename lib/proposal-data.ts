// Load one proposal (and the template it renders with) from the database
// into a render model. Org-scoped throughout; shared by the in-app editor,
// the PDF routes, and envelope creation.
import type { Db } from "./db.ts";
import { parseTemplateBody, type TemplateBody } from "./doc-template.ts";
import { fileMeta, getFile } from "./files.ts";
import {
  buildRenderModel,
  formatDatePrepared,
  type FileRef,
  type ModelLine,
  type RenderModel,
} from "./proposal-model.ts";
import type { FileBytes } from "./proposal-pdf.ts";
import { SAMPLE_CUSTOMER, SAMPLE_LINES } from "./template-sample.ts";

export interface ProposalRow {
  id: number;
  org_id: string;
  job_id: number;
  name: string;
  status: string;
  template_id: number | null;
  total_cents: number;
  cost_cents: number;
  created_at: string;
  job_title: string;
  address: string;
  assignee_id: number | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
}

export interface TemplateRow {
  id: number;
  name: string;
  kind: string;
  body: string | null;
}

export interface LineRow {
  id: number;
  sku: string;
  name: string;
  unit: string;
  qty: number;
  unit_price_cents: number;
  unit_cost_cents: number;
  section: string;
  notes: string;
  position: number;
}

export async function orgName(db: Db, orgId: string): Promise<string> {
  return (await db.get<{ name: string }>("SELECT name FROM orgs WHERE id = ?", orgId))?.name ?? "";
}

export async function getProposal(db: Db, orgId: string, proposalId: number): Promise<ProposalRow | undefined> {
  return db.get<ProposalRow>(
    `SELECT p.id, p.org_id, p.job_id, p.name, p.status, p.template_id, p.total_cents, p.cost_cents, p.created_at,
            j.title AS job_title, j.address, j.assignee_id,
            c.name AS contact_name, c.email AS contact_email, c.phone AS contact_phone
     FROM proposals p JOIN jobs j ON j.id = p.job_id AND j.org_id = p.org_id
     LEFT JOIN contacts c ON c.id = j.contact_id AND c.org_id = p.org_id
     WHERE p.id = ? AND p.org_id = ?`,
    proposalId, orgId,
  );
}

export async function getLines(db: Db, orgId: string, proposalId: number): Promise<LineRow[]> {
  return db.all<LineRow>(
    `SELECT id, sku, name, unit, qty, unit_price_cents, unit_cost_cents, section, notes, position
     FROM proposal_lines WHERE proposal_id = ? AND org_id = ? ORDER BY position, id`,
    proposalId, orgId,
  );
}

/** The proposal's own template, else the org's first proposal template. */
export async function templateFor(db: Db, orgId: string, templateId: number | null): Promise<TemplateRow | undefined> {
  if (templateId) {
    const t = await db.get<TemplateRow>(
      "SELECT id, name, kind, body FROM templates WHERE id = ? AND org_id = ? AND kind = 'proposal'",
      templateId, orgId,
    );
    if (t) return t;
  }
  return db.get<TemplateRow>(
    "SELECT id, name, kind, body FROM templates WHERE org_id = ? AND kind = 'proposal' ORDER BY id LIMIT 1",
    orgId,
  );
}

export async function loadTemplateBody(db: Db, orgId: string, row: TemplateRow | undefined): Promise<TemplateBody> {
  return parseTemplateBody(row?.body ?? null, await orgName(db, orgId));
}

/** Every file id a template can reference (logo + listed attachments). */
export function templateFileIds(t: TemplateBody): number[] {
  const ids: number[] = [];
  if (t.branding.logo_file_id) ids.push(t.branding.logo_file_id);
  for (const b of t.blocks) if (b.type === "attachments") ids.push(...b.file_ids);
  return ids;
}

async function catalogueSpecs(db: Db, orgId: string, skus: string[]): Promise<FileRef[]> {
  const unique = [...new Set(skus)].filter(Boolean);
  if (!unique.length) return [];
  const rows = await db.all<{ spec_file_id: number; filename: string; sha256: string }>(
    `SELECT c.spec_file_id, f.filename, f.sha256 FROM catalogue c
     JOIN files f ON f.id = c.spec_file_id AND f.org_id = c.org_id
     WHERE c.org_id = ? AND c.spec_file_id IS NOT NULL AND c.sku IN (${unique.map(() => "?").join(",")})
     ORDER BY c.id`,
    orgId, ...unique,
  );
  return rows.map((r) => ({ file_id: Number(r.spec_file_id), filename: r.filename, sha256: r.sha256 }));
}

export interface LoadedProposal {
  proposal: ProposalRow;
  lines: LineRow[];
  template: TemplateRow | undefined;
  model: RenderModel;
  rep: { id: number | null; name: string; email: string };
}

export async function loadProposalModel(
  db: Db,
  orgId: string,
  proposalId: number,
  fallbackRep: { id: number; name: string; email: string },
  now = new Date(),
): Promise<LoadedProposal | null> {
  const proposal = await getProposal(db, orgId, proposalId);
  if (!proposal) return null;
  const [lines, template] = [await getLines(db, orgId, proposalId), await templateFor(db, orgId, proposal.template_id)];
  const body = await loadTemplateBody(db, orgId, template);

  // The rep on the document is the job's assignee (the person the customer
  // knows), falling back to whoever is looking at it.
  const assignee = proposal.assignee_id
    ? await db.get<{ id: number; name: string; email: string }>(
        "SELECT id, name, email FROM users WHERE id = ? AND org_id = ?",
        proposal.assignee_id, orgId,
      )
    : undefined;
  const rep = assignee ? { id: Number(assignee.id), name: assignee.name, email: assignee.email } : fallbackRep;

  const modelLines: ModelLine[] = lines.map((l) => ({
    section: l.section ?? "",
    name: l.name,
    notes: l.notes ?? "",
    qty: Number(l.qty),
    unit: l.unit,
    unit_price_cents: Number(l.unit_price_cents),
    sku: l.sku,
  }));
  const meta = await fileMeta(db, orgId, templateFileIds(body));
  const files = new Map<number, FileRef>();
  for (const [id, m] of meta) files.set(id, { file_id: id, filename: m.filename, sha256: m.sha256 });
  // A logo id that points at a non-image (or a deleted file) is ignored.
  if (body.branding.logo_file_id && !meta.get(body.branding.logo_file_id)?.content_type.startsWith("image/")) {
    body.branding.logo_file_id = null;
  }

  const model = buildRenderModel({
    template: body,
    proposal: { id: Number(proposal.id), name: proposal.name },
    lines: modelLines,
    customer: {
      name: proposal.contact_name ?? "",
      email: proposal.contact_email ?? "",
      phone: proposal.contact_phone ?? "",
      address: proposal.address ?? "",
    },
    rep: { name: rep.name, email: rep.email, phone: body.branding.phone, address: "" },
    catalogueSpecs: await catalogueSpecs(db, orgId, modelLines.map((l) => l.sku)),
    files,
    today: formatDatePrepared(now),
  });
  return { proposal, lines, template, model, rep };
}

/** loadFile callback for the PDF renderer, fenced to one org. */
export function fileLoader(db: Db, orgId: string) {
  return async (id: number): Promise<FileBytes | null> => {
    const f = await getFile(db, orgId, id);
    return f ? { bytes: f.bytes, content_type: f.content_type, sha256: f.sha256 } : null;
  };
}

/** A template rendered against sample data — the template editor preview. */
export async function sampleModel(
  db: Db,
  orgId: string,
  template: TemplateRow,
  rep: { name: string; email: string },
  now = new Date(),
): Promise<RenderModel> {
  const body = await loadTemplateBody(db, orgId, template);
  const meta = await fileMeta(db, orgId, templateFileIds(body));
  const files = new Map<number, FileRef>();
  for (const [id, m] of meta) files.set(id, { file_id: id, filename: m.filename, sha256: m.sha256 });
  if (body.branding.logo_file_id && !meta.get(body.branding.logo_file_id)?.content_type.startsWith("image/")) {
    body.branding.logo_file_id = null;
  }
  return buildRenderModel({
    template: body,
    proposal: { id: 0, name: `${template.name} (sample)` },
    lines: SAMPLE_LINES,
    customer: SAMPLE_CUSTOMER,
    rep: { name: rep.name, email: rep.email, phone: body.branding.phone, address: "" },
    catalogueSpecs: [],
    files,
    today: formatDatePrepared(now),
  });
}
