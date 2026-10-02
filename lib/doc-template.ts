// Document templates: a template is branding plus an ordered list of blocks.
// A filled-in proposal (like 8 Square's "1924 Bobbywoods Lane" PDF) is this
// layout rendered against one proposal's data — cover page, estimate
// sections, summary + signatures, manufacturer spec sheets, then terms.
//
// Pure module (no db, no Next) so the parser, merge fields and rich-text
// rules are unit-tested directly and shared by the HTML view and the PDF.

export interface Stat {
  value: string;
  label: string;
}

export interface Branding {
  company_name: string;
  tagline: string;
  /** Hex colour for headings rules, stat numbers and the page bar. */
  accent: string;
  /** files.id of a PNG/JPEG logo, or null to render the company name. */
  logo_file_id: number | null;
  /** Office phone shown with the rep in the page footer. */
  phone: string;
  stats: Stat[];
}

export type Block =
  | { id: string; type: "cover"; title: string }
  | {
      id: string;
      type: "line_items";
      title: string;
      show_prices: boolean;
      show_subtotal: boolean;
    }
  | {
      id: string;
      type: "summary";
      title: string;
      intro: string;
      consent: string;
      /** Countersignature by the sending rep (the Bobbywoods layout). */
      contractor_signs: boolean;
    }
  | {
      id: string;
      type: "attachments";
      title: string;
      /** Spec sheets attached to catalogue items on the proposal. */
      include_catalogue_specs: boolean;
      file_ids: number[];
    }
  | { id: string; type: "text"; title: string; body: string };

export type BlockType = Block["type"];

export interface TemplateBody {
  version: 1;
  branding: Branding;
  blocks: Block[];
}

export const BLOCK_LABELS: Record<BlockType, string> = {
  cover: "Cover page",
  line_items: "Estimate (line items)",
  summary: "Summary & signatures",
  attachments: "Attachments (spec sheets)",
  text: "Text section (terms, scope, warranty…)",
};

export const MERGE_FIELDS: ReadonlyArray<readonly [string, string]> = [
  ["company.name", "Your company name"],
  ["customer.name", "Customer name"],
  ["customer.email", "Customer email"],
  ["customer.phone", "Customer phone"],
  ["job.address", "Job address"],
  ["proposal.name", "Proposal name"],
  ["proposal.total", "Proposal total"],
  ["rep.name", "Sending rep"],
  ["rep.email", "Rep email"],
  ["rep.phone", "Rep phone"],
  ["today", "Date prepared"],
];

let seq = 0;
export function newBlockId(): string {
  seq = (seq + 1) % 1_000_000;
  return `b${Date.now().toString(36)}${seq.toString(36)}`;
}

export function blankBlock(type: BlockType, id = newBlockId()): Block {
  switch (type) {
    case "cover":
      return { id, type, title: "Proposal" };
    case "line_items":
      return { id, type, title: "Estimate", show_prices: false, show_subtotal: true };
    case "summary":
      return {
        id,
        type,
        title: "Summary",
        intro: "Please review and sign the proposal with any notes.",
        consent:
          "By signing this document you agree to the statement of works provided by {{company.name}} and in accordance with any terms described within.",
        contractor_signs: true,
      };
    case "attachments":
      return { id, type, title: "Product information", include_catalogue_specs: true, file_ids: [] };
    case "text":
      return { id, type, title: "Terms and Conditions", body: "" };
  }
}

/** The built-in layout — the shape of the Bobbywoods proposal. Used for any
 *  template whose body is unset (rows created before templates had bodies). */
export function defaultProposalTemplate(companyName = ""): TemplateBody {
  return {
    version: 1,
    branding: {
      company_name: companyName,
      tagline: "",
      accent: "#C8102E",
      logo_file_id: null,
      phone: "",
      stats: [],
    },
    blocks: [
      blankBlock("cover", "cover"),
      { ...(blankBlock("line_items", "estimate") as Extract<Block, { type: "line_items" }>), title: "Roof Estimate" },
      blankBlock("summary", "summary"),
      blankBlock("attachments", "attachments"),
      {
        id: "terms",
        type: "text",
        title: "Terms and Conditions",
        body: [
          "These Terms and Conditions govern all services provided by {{company.name}} to the Customer identified in the attached proposal.",
          "",
          "## 1. SCOPE OF SERVICES",
          "Edit this section in Templates to add your own terms.",
          "",
          "## 2. PAYMENT TERMS",
          "A deposit equal to fifty percent (50%) of the contract amount is due before materials are ordered or work begins. The remaining balance is due upon Substantial Completion.",
          "",
          "All estimates remain valid for thirty (30) days unless otherwise stated in writing.",
        ].join("\n"),
      },
    ],
  };
}

// ── Parsing / validation ──────────────────────────────────────────────
// Template bodies are edited through forms, but they're stored JSON and
// everything downstream (PDF layout, signing snapshot) trusts the shape —
// so normalise defensively: unknown blocks dropped, strings clamped.

const str = (v: unknown, max = 20_000): string =>
  typeof v === "string" ? v.slice(0, max) : "";
const bool = (v: unknown, dflt: boolean): boolean => (typeof v === "boolean" ? v : dflt);
const fileId = (v: unknown): number | null =>
  typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null;

export function normalizeAccent(v: unknown): string {
  const s = str(v, 16).trim();
  return /^#[0-9a-fA-F]{6}$/.test(s) ? s.toUpperCase() : "#C8102E";
}

function normalizeBlock(raw: unknown): Block | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id, 40).replace(/[^\w-]/g, "") || newBlockId();
  switch (r.type) {
    case "cover":
      return { id, type: "cover", title: str(r.title, 120) };
    case "line_items":
      return {
        id,
        type: "line_items",
        title: str(r.title, 120),
        show_prices: bool(r.show_prices, false),
        show_subtotal: bool(r.show_subtotal, true),
      };
    case "summary":
      return {
        id,
        type: "summary",
        title: str(r.title, 120),
        intro: str(r.intro, 2000),
        consent: str(r.consent, 2000),
        contractor_signs: bool(r.contractor_signs, true),
      };
    case "attachments":
      return {
        id,
        type: "attachments",
        title: str(r.title, 120),
        include_catalogue_specs: bool(r.include_catalogue_specs, true),
        file_ids: Array.isArray(r.file_ids)
          ? [...new Set(r.file_ids.map(fileId).filter((x): x is number => x !== null))].slice(0, 30)
          : [],
      };
    case "text":
      return { id, type: "text", title: str(r.title, 120), body: str(r.body, 60_000) };
    default:
      return null;
  }
}

export function normalizeTemplate(raw: unknown, companyName = ""): TemplateBody {
  if (!raw || typeof raw !== "object") return defaultProposalTemplate(companyName);
  const r = raw as Record<string, unknown>;
  const b = (r.branding && typeof r.branding === "object" ? r.branding : {}) as Record<string, unknown>;
  const stats = Array.isArray(b.stats)
    ? b.stats
        .map((s) => {
          const o = (s && typeof s === "object" ? s : {}) as Record<string, unknown>;
          return { value: str(o.value, 24).trim(), label: str(o.label, 40).trim() };
        })
        .filter((s) => s.value || s.label)
        .slice(0, 4)
    : [];
  const blocks = Array.isArray(r.blocks)
    ? r.blocks.map(normalizeBlock).filter((x): x is Block => x !== null).slice(0, 40)
    : [];
  // Block ids address edit forms — make them unique.
  const seen = new Set<string>();
  for (const blk of blocks) {
    while (seen.has(blk.id)) blk.id = newBlockId();
    seen.add(blk.id);
  }
  return {
    version: 1,
    branding: {
      company_name: str(b.company_name, 120) || companyName,
      tagline: str(b.tagline, 160),
      accent: normalizeAccent(b.accent),
      logo_file_id: fileId(b.logo_file_id),
      phone: str(b.phone, 40).trim(),
      stats,
    },
    blocks,
  };
}

/** Parse a templates.body column (JSON text or NULL). */
export function parseTemplateBody(body: string | null | undefined, companyName = ""): TemplateBody {
  if (!body) return defaultProposalTemplate(companyName);
  try {
    return normalizeTemplate(JSON.parse(body), companyName);
  } catch {
    return defaultProposalTemplate(companyName);
  }
}

// ── Merge fields ──────────────────────────────────────────────────────

export type MergeContext = Record<string, string>;

/** Replace {{field}} tokens. Unknown fields render empty rather than
 *  leaking template syntax into a customer document. */
export function mergeFields(text: string, ctx: MergeContext): string {
  return text.replace(/\{\{\s*([a-z_.]+)\s*\}\}/gi, (_, key: string) => ctx[key.toLowerCase()] ?? "");
}

// ── Rich text ─────────────────────────────────────────────────────────
// Deliberately tiny so it renders identically in HTML and the PDF:
//   "## Heading"      → section heading
//   "- item" / "· item" / "• item" → bullet
//   blank line        → paragraph break; other lines join into a paragraph

export type RichNode =
  | { kind: "heading"; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "bullet"; text: string };

export function parseRichText(body: string): RichNode[] {
  const out: RichNode[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push({ kind: "paragraph", text: para.join(" ") });
    para = [];
  };
  for (const rawLine of body.replace(/\r\n?/g, "\n").split("\n")) {
    const line = rawLine.trim();
    if (!line) {
      flush();
      continue;
    }
    const h = /^#{1,3}\s+(.*)$/.exec(line);
    if (h) {
      flush();
      out.push({ kind: "heading", text: h[1].trim() });
      continue;
    }
    const li = /^[-•·*]\s+(.*)$/.exec(line);
    if (li) {
      flush();
      out.push({ kind: "bullet", text: li[1].trim() });
      continue;
    }
    para.push(line);
  }
  flush();
  return out;
}
