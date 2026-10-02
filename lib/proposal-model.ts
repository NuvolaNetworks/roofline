// The render model: a template applied to one proposal's data, resolved
// into plain JSON. It is the single input to BOTH renderers (the HTML view
// in components/ProposalDocument.tsx and the PDF in lib/proposal-pdf.ts),
// and — frozen and hashed — it is exactly what a signer signs (see
// lib/esign.ts). Pure: callers load the rows, this shapes them.
import {
  mergeFields,
  parseRichText,
  type Branding,
  type MergeContext,
  type RichNode,
  type TemplateBody,
} from "./doc-template.ts";

export interface PartyInfo {
  name: string;
  email: string;
  phone: string;
  address: string;
}

export interface ModelLine {
  section: string;
  name: string;
  notes: string;
  qty: number;
  unit: string;
  unit_price_cents: number;
  sku: string;
}

export interface FileRef {
  file_id: number;
  filename: string;
  sha256: string;
}

export interface ModelInput {
  template: TemplateBody;
  proposal: { id: number; name: string };
  lines: ModelLine[];
  customer: PartyInfo;
  rep: PartyInfo;
  /** Spec sheets of catalogue items whose SKU appears on the proposal. */
  catalogueSpecs: FileRef[];
  /** Metadata for files referenced by the template (logo, attachments). */
  files: Map<number, FileRef>;
  /** Date prepared, already formatted (e.g. "Aug 24, 2026"). */
  today: string;
}

export interface RenderLine {
  name: string;
  notes: string[];
  qty: string;
  unit: string;
  amount_cents: number;
}

export type RenderBlock =
  | { type: "cover"; title: string }
  | {
      type: "line_items";
      title: string;
      show_prices: boolean;
      show_subtotal: boolean;
      groups: Array<{ name: string; lines: RenderLine[] }>;
      subtotal_cents: number;
    }
  | {
      type: "summary";
      title: string;
      intro: string;
      consent: string;
      rows: Array<{ label: string; amount_cents: number }>;
      total_cents: number;
      signers: Array<{ role: "customer" | "contractor"; label: string }>;
    }
  | { type: "attachments"; title: string; files: FileRef[] }
  | { type: "text"; title: string; nodes: RichNode[] };

export interface RenderModel {
  version: 1;
  branding: Branding;
  logo: FileRef | null;
  proposal: { id: number; name: string; date_prepared: string };
  customer: PartyInfo;
  rep: PartyInfo & { company: string };
  total_cents: number;
  blocks: RenderBlock[];
}

export function money(cents: number): string {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

/** "103", "2.5", "36.3" — quantities as people write them. */
export function formatQty(qty: number): string {
  if (!Number.isFinite(qty)) return "0";
  return String(Math.round(qty * 100) / 100);
}

const titleCase = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase());

export function lineAmount(l: Pick<ModelLine, "qty" | "unit_price_cents">): number {
  return Math.round(l.qty * l.unit_price_cents);
}

export function buildRenderModel(input: ModelInput): RenderModel {
  const { template, proposal, lines, customer, rep } = input;
  const branding = template.branding;
  const company = branding.company_name;
  const total = lines.reduce((s, l) => s + lineAmount(l), 0);

  const ctx: MergeContext = {
    "company.name": company,
    "customer.name": customer.name,
    "customer.email": customer.email,
    "customer.phone": customer.phone,
    "job.address": customer.address,
    "proposal.name": proposal.name,
    "proposal.total": money(total),
    "rep.name": rep.name,
    "rep.email": rep.email,
    "rep.phone": rep.phone,
    today: input.today,
  };
  const m = (s: string) => mergeFields(s, ctx);

  // Group lines by section, preserving first-appearance order.
  const groups: Array<{ name: string; lines: RenderLine[] }> = [];
  const byName = new Map<string, { name: string; lines: RenderLine[] }>();
  for (const l of lines) {
    const name = l.section.trim();
    let g = byName.get(name);
    if (!g) {
      g = { name, lines: [] };
      byName.set(name, g);
      groups.push(g);
    }
    g.lines.push({
      name: l.name,
      notes: l.notes
        .replace(/\r\n?/g, "\n")
        .split("\n")
        .map((x) => x.trimEnd())
        .filter((x) => x.trim()),
      qty: formatQty(l.qty),
      unit: titleCase(l.unit),
      amount_cents: lineAmount(l),
    });
  }

  const blocks: RenderBlock[] = [];
  const estimateTitles: string[] = [];
  for (const b of template.blocks) {
    if (b.type === "line_items") estimateTitles.push(m(b.title) || "Estimate");
  }

  for (const b of template.blocks) {
    switch (b.type) {
      case "cover":
        blocks.push({ type: "cover", title: m(b.title) || "Proposal" });
        break;
      case "line_items":
        blocks.push({
          type: "line_items",
          title: m(b.title) || "Estimate",
          show_prices: b.show_prices,
          show_subtotal: b.show_subtotal,
          groups,
          subtotal_cents: total,
        });
        break;
      case "summary": {
        const signers: Array<{ role: "customer" | "contractor"; label: string }> = [
          { role: "customer", label: customer.name || "Customer" },
        ];
        if (b.contractor_signs) {
          signers.push({
            role: "contractor",
            label: [rep.name, company].filter(Boolean).join(", ") || "Contractor",
          });
        }
        blocks.push({
          type: "summary",
          title: m(b.title) || "Summary",
          intro: m(b.intro),
          consent: m(b.consent),
          // One estimate block → one row; the Bobbywoods summary shows
          // "Roof Estimate  $25,612.69" above the total.
          rows: (estimateTitles.length ? estimateTitles.slice(0, 1) : ["Estimate"]).map((label) => ({
            label,
            amount_cents: total,
          })),
          total_cents: total,
          signers,
        });
        break;
      }
      case "attachments": {
        const files: FileRef[] = [];
        const seen = new Set<number>();
        const add = (f: FileRef | undefined) => {
          if (f && !seen.has(f.file_id)) {
            seen.add(f.file_id);
            files.push(f);
          }
        };
        if (b.include_catalogue_specs) input.catalogueSpecs.forEach(add);
        b.file_ids.forEach((id) => add(input.files.get(id)));
        if (files.length) blocks.push({ type: "attachments", title: m(b.title), files });
        break;
      }
      case "text":
        blocks.push({ type: "text", title: m(b.title), nodes: parseRichText(m(b.body)) });
        break;
    }
  }

  return {
    version: 1,
    branding,
    logo: branding.logo_file_id ? input.files.get(branding.logo_file_id) ?? null : null,
    proposal: { id: proposal.id, name: proposal.name, date_prepared: input.today },
    customer,
    rep: { ...rep, company },
    total_cents: total,
    blocks,
  };
}

/** Which signer roles a model expects (from its summary block; a template
 *  without one still needs the customer's signature). */
export function signerRoles(model: RenderModel): Array<{ role: "customer" | "contractor"; label: string }> {
  const s = model.blocks.find((b) => b.type === "summary");
  return s && s.type === "summary" ? s.signers : [{ role: "customer", label: model.customer.name || "Customer" }];
}

/** "1924 Bobbywoods Lane, Manchaca, TX 78652" → street / city line. */
export function addressLines(address: string): string[] {
  const a = address.trim();
  if (!a) return [];
  if (a.includes("\n")) return a.split("\n").map((s) => s.trim()).filter(Boolean);
  const parts = a.split(",");
  if (parts.length >= 3) return [parts[0].trim(), parts.slice(1).join(",").trim()];
  return [a];
}

export function formatDatePrepared(d: Date): string {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/Chicago" });
}
