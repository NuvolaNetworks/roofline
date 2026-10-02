// PDF renderer for the proposal render model (lib/proposal-model.ts).
//
// pdf-lib only — pure JS, no headless browser, nothing native — so the
// container stays a plain node:alpine image and rendering is fast enough to
// run on every preview. The layout reproduces the shape of a contractor
// proposal: branded cover, estimate pages with a header bar and a rep
// footer, summary with signature lines, spec-sheet PDFs appended as-is,
// rich-text terms, and (once signed) a signature certificate page.
import {
  PDFDocument,
  StandardFonts,
  rgb,
  type PDFFont,
  type PDFImage,
  type PDFPage,
  type RGB,
} from "pdf-lib";
import { addressLines, money, type RenderBlock, type RenderModel } from "./proposal-model.ts";
import type { RichNode } from "./doc-template.ts";

export interface SignatureMark {
  role: "customer" | "contractor";
  name: string;
  png: Uint8Array;
  /** Display date, e.g. "10/02/2026". */
  date: string;
}

export interface AuditSigner {
  role: string;
  name: string;
  email: string;
  method: string;
  ip: string;
  user_agent: string;
  viewed_at: string;
  signed_at: string;
  consent_text: string;
}

export interface AuditInfo {
  envelope_id: number;
  document_sha256: string;
  created_at: string;
  completed_at: string;
  signers: AuditSigner[];
  events: Array<{ at: string; event: string; who: string; ip: string }>;
}

export interface FileBytes {
  bytes: Uint8Array;
  content_type: string;
  sha256: string;
}

export interface RenderOptions {
  loadFile: (fileId: number) => Promise<FileBytes | null>;
  signatures?: SignatureMark[];
  audit?: AuditInfo;
  /** Marks every content page "PREVIEW" in the footer. */
  preview?: boolean;
  /** Refuse to render if a referenced file's bytes no longer match the
   *  hash frozen in the model — a signed document must be the document
   *  that was signed. */
  strictHashes?: boolean;
}

const W = 612;
const H = 792;
const M = 36;
const FOOTER_TOP = 118;
const INK = rgb(0.16, 0.2, 0.24);
const MUTED = rgb(0.42, 0.45, 0.5);
const RULE = rgb(0.82, 0.83, 0.85);
const WHITE = rgb(1, 1, 1);
const BLACK = rgb(0, 0, 0);

function hexColor(hex: string): RGB {
  const n = parseInt(hex.replace("#", ""), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
  italic: PDFFont;
}

// Standard fonts are WinAnsi-encoded; anything outside that set would make
// pdf-lib throw mid-render. Map the usual suspects, drop the rest.
const FALLBACK: Record<string, string> = {
  "‘": "'", "’": "'", "“": '"', "”": '"', "–": "-", "—": "-",
  "•": "-", "·": "-", "…": "...", " ": " ", "′": "'", "″": '"',
};
const charsetCache = new WeakMap<PDFFont, Set<number>>();
export function safeText(font: PDFFont, s: string): string {
  let set = charsetCache.get(font);
  if (!set) {
    set = new Set(font.getCharacterSet());
    charsetCache.set(font, set);
  }
  let out = "";
  for (const ch of s.replace(/[\t\r\n]+/g, " ")) {
    const cp = ch.codePointAt(0)!;
    if (set.has(cp)) out += ch;
    else if (FALLBACK[ch] && [...FALLBACK[ch]].every((c) => set!.has(c.codePointAt(0)!))) out += FALLBACK[ch];
    else out += "?";
  }
  return out;
}

export function wrap(font: PDFFont, text: string, size: number, maxWidth: number): string[] {
  const words = safeText(font, text).split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      line = candidate;
      continue;
    }
    if (line) lines.push(line);
    // A single word wider than the column is hard-broken.
    let rest = word;
    while (font.widthOfTextAtSize(rest, size) > maxWidth && rest.length > 1) {
      let cut = rest.length - 1;
      while (cut > 1 && font.widthOfTextAtSize(rest.slice(0, cut), size) > maxWidth) cut--;
      lines.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    line = rest;
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

class Writer {
  page!: PDFPage;
  y = 0;
  pageNo = 0;
  private header = "";
  readonly doc: PDFDocument;
  readonly fonts: Fonts;
  readonly model: RenderModel;
  readonly accent: RGB;
  readonly logo: PDFImage | null;
  readonly preview: boolean;

  // Plain fields, not parameter properties: tests run under Node's
  // strip-only TypeScript, which rejects those.
  constructor(doc: PDFDocument, fonts: Fonts, model: RenderModel, accent: RGB, logo: PDFImage | null, preview: boolean) {
    this.doc = doc;
    this.fonts = fonts;
    this.model = model;
    this.accent = accent;
    this.logo = logo;
    this.preview = preview;
  }

  text(s: string, x: number, y: number, size: number, font = this.fonts.regular, color: RGB = INK) {
    this.page.drawText(safeText(font, s), { x, y, size, font, color });
  }

  textRight(s: string, xRight: number, y: number, size: number, font = this.fonts.regular, color: RGB = INK) {
    const t = safeText(font, s);
    this.page.drawText(t, { x: xRight - font.widthOfTextAtSize(t, size), y, size, font, color });
  }

  rule(y: number, x1 = M, x2 = W - M, color: RGB = RULE, thickness = 0.75) {
    this.page.drawLine({ start: { x: x1, y }, end: { x: x2, y }, thickness, color });
  }

  /** Start a content page: accent bar, page heading, rep footer. */
  contentPage(heading: string) {
    this.header = heading;
    this.page = this.doc.addPage([W, H]);
    this.pageNo = this.doc.getPageCount();
    this.page.drawRectangle({ x: 12, y: H - 22, width: W - 24, height: 8, color: this.accent });
    this.text(heading, 14, H - 56, 20, this.fonts.bold);
    this.footer();
    this.y = H - 82;
  }

  footer() {
    const p = this.page;
    const rep = this.model.rep;
    p.drawLine({ start: { x: M, y: FOOTER_TOP }, end: { x: W - M, y: FOOTER_TOP }, thickness: 0.75, color: RULE });
    let y = FOOTER_TOP - 22;
    for (const line of [rep.name, rep.company, rep.phone, rep.email].filter(Boolean)) {
      this.text(line, M, y, 9.5);
      y -= 12;
    }
    this.mark(W - M - 150, 30, 150, 46);
    this.text(String(this.doc.getPageCount()), 14, 16, 9, this.fonts.regular, MUTED);
    if (this.preview) this.textRight("PREVIEW — not for signature", W - M, 16, 8, this.fonts.italic, MUTED);
  }

  /** Logo (or the company name on a black tile) inside a box. */
  mark(x: number, y: number, w: number, h: number) {
    if (this.logo) {
      const s = Math.min(w / this.logo.width, h / this.logo.height);
      const dw = this.logo.width * s;
      const dh = this.logo.height * s;
      this.page.drawImage(this.logo, { x: x + w - dw, y: y + (h - dh) / 2, width: dw, height: dh });
      return;
    }
    const name = this.model.branding.company_name;
    if (!name) return;
    this.page.drawRectangle({ x, y, width: w, height: h, color: BLACK });
    const lines = wrap(this.fonts.bold, name.toUpperCase(), 11, w - 12).slice(0, 2);
    let ty = y + h / 2 + (lines.length - 1) * 6 - 4;
    for (const l of lines) {
      const tw = this.fonts.bold.widthOfTextAtSize(l, 11);
      this.page.drawText(l, { x: x + (w - tw) / 2, y: ty, size: 11, font: this.fonts.bold, color: WHITE });
      ty -= 13;
    }
  }

  /** Make room for `h` points, continuing on a fresh page if needed. */
  ensure(h: number) {
    if (this.y - h < FOOTER_TOP + 14) this.contentPage(this.header);
  }

  paragraph(s: string, size: number, x = M, width = W - 2 * M, font = this.fonts.regular, color: RGB = INK, leading = 1.45) {
    for (const line of wrap(font, s, size, width)) {
      this.ensure(size * leading);
      this.y -= size * leading;
      this.text(line, x, this.y, size, font, color);
    }
  }
}

// ── Blocks ────────────────────────────────────────────────────────────

function cover(w: Writer, title: string) {
  const { model, fonts } = w;
  w.page = w.doc.addPage([W, H]);
  const p = w.page;
  const bandBottom = H - 470;
  p.drawRectangle({ x: 0, y: bandBottom, width: W, height: 470, color: BLACK });

  if (w.logo) {
    const maxW = 470;
    const maxH = 190;
    const s = Math.min(maxW / w.logo.width, maxH / w.logo.height);
    const dw = w.logo.width * s;
    const dh = w.logo.height * s;
    p.drawImage(w.logo, { x: (W - dw) / 2, y: H - 70 - dh, width: dw, height: dh });
  } else {
    const name = safeText(fonts.bold, model.branding.company_name.toUpperCase() || "PROPOSAL");
    let size = 64;
    while (size > 20 && fonts.bold.widthOfTextAtSize(name, size) > W - 100) size -= 2;
    const tw = fonts.bold.widthOfTextAtSize(name, size);
    p.drawText(name, { x: (W - tw) / 2, y: H - 190, size, font: fonts.bold, color: WHITE });
    p.drawRectangle({ x: 72, y: H - 210, width: W - 144, height: 2.5, color: w.accent });
  }
  if (model.branding.tagline) {
    const t = safeText(fonts.italic, model.branding.tagline);
    const size = 12;
    const tw = fonts.italic.widthOfTextAtSize(t, size);
    p.drawText(t, { x: (W - tw) / 2, y: H - 285, size, font: fonts.italic, color: rgb(0.6, 0.6, 0.6) });
  }

  const stats = model.branding.stats;
  if (stats.length) {
    const top = H - 310;
    const boxH = 100;
    const boxW = W / stats.length;
    stats.forEach((s, i) => {
      const x = i * boxW;
      p.drawRectangle({ x, y: top - boxH, width: boxW, height: boxH, borderColor: w.accent, borderWidth: 1.2 });
      const v = safeText(fonts.bold, s.value);
      let vs = 40;
      while (vs > 14 && fonts.bold.widthOfTextAtSize(v, vs) > boxW - 16) vs -= 2;
      p.drawText(v, { x: x + (boxW - fonts.bold.widthOfTextAtSize(v, vs)) / 2, y: top - 52, size: vs, font: fonts.bold, color: w.accent });
      const l = safeText(fonts.bold, s.label.toUpperCase());
      let ls = 9;
      while (ls > 6 && fonts.bold.widthOfTextAtSize(l, ls) > boxW - 10) ls -= 0.5;
      p.drawText(l, { x: x + (boxW - fonts.bold.widthOfTextAtSize(l, ls)) / 2, y: top - 76, size: ls, font: fonts.bold, color: WHITE });
    });
  }
  p.drawRectangle({ x: 0, y: bandBottom - 9, width: W, height: 9, color: w.accent });

  // Prepared-for block.
  let y = bandBottom - 50;
  w.text("Date Prepared", M, y, 9.5);
  w.text(model.proposal.date_prepared, M, y - 13, 9.5, fonts.bold);
  w.text(title, M, y - 45, 24, fonts.bold);
  const c = model.customer;
  for (const line of [c.name, c.email, c.phone, ...addressLines(c.address)].filter(Boolean)) {
    w.textRight(line, W - M, y - 30, 11.5);
    y -= 15;
  }

  let ry = 92;
  for (const line of [model.rep.name, model.rep.company, model.rep.phone, model.rep.email].filter(Boolean)) {
    w.text(line, M - 6, ry, 9.5);
    ry -= 12;
  }
  w.mark(W - M - 150, 30, 150, 46);
}

function lineItems(w: Writer, b: Extract<RenderBlock, { type: "line_items" }>) {
  const { fonts } = w;
  w.contentPage(b.title);
  const right = W - M;
  const amountCol = b.show_prices ? right : null;
  const qtyRight = b.show_prices ? right - 90 : right;
  const textW = qtyRight - 120 - (M + 12);

  w.y -= 12;
  w.text("Item", M, w.y, 8.5, fonts.regular, MUTED);
  w.textRight("Qty", qtyRight, w.y, 8.5, fonts.regular, MUTED);
  if (amountCol) w.textRight("Amount", amountCol, w.y, 8.5, fonts.regular, MUTED);
  w.y -= 10;
  w.rule(w.y, M, right, INK);

  for (const g of b.groups) {
    w.ensure(44);
    w.y -= 26;
    w.text(g.name || "Items", M, w.y, 13);
    w.y -= 12;
    w.rule(w.y);
    for (const l of g.lines) {
      const nameLines = wrap(fonts.regular, l.name, 10, textW);
      const noteLines = l.notes.flatMap((n) => wrap(fonts.regular, n, 9.5, textW + 60));
      const need = 14 + nameLines.length * 14 + noteLines.length * 13 + 8;
      w.ensure(Math.min(need, 200));
      w.y -= 18;
      w.textRight(`${l.qty} ${l.unit}`.trim(), qtyRight, w.y, 10);
      if (amountCol) w.textRight(money(l.amount_cents), amountCol, w.y, 10);
      nameLines.forEach((t, i) => {
        if (i) w.y -= 13;
        w.text(t, M + 12, w.y, 10);
      });
      w.y -= 3;
      for (const t of noteLines) {
        w.ensure(13);
        w.y -= 13;
        w.text(t, M + 12, w.y, 9.5, fonts.regular, BLACK);
      }
      w.y -= 10;
      w.rule(w.y, M + 12, right);
    }
  }
  if (b.show_subtotal) {
    w.ensure(40);
    w.y -= 6;
    w.rule(w.y, M, right, INK);
    w.y -= 22;
    w.text("Estimate subtotal", M, w.y, 13);
    w.textRight(money(b.subtotal_cents), right, w.y + 4, 13);
  }
}

async function summary(w: Writer, b: Extract<RenderBlock, { type: "summary" }>, sigs: SignatureMark[]) {
  const { fonts, doc } = w;
  w.contentPage(b.title);
  const right = W - M;
  if (b.intro) w.paragraph(b.intro, 10);
  w.y -= 16;
  for (const r of b.rows) {
    w.page.drawRectangle({ x: M, y: w.y - 40, width: right - M, height: 40, borderColor: RULE, borderWidth: 0.75 });
    w.text(r.label, M + 22, w.y - 25, 11.5, fonts.bold);
    w.textRight(money(r.amount_cents), right - 22, w.y - 25, 11.5);
    w.y -= 52;
  }
  w.y -= 10;
  w.rule(w.y, W / 2, right, INK);
  w.y -= 20;
  w.text("Total", W / 2, w.y, 12, fonts.bold);
  w.textRight(money(b.total_cents), right, w.y, 12, fonts.bold);
  w.y -= 26;

  const sigRight = right - 210;
  for (const s of b.signers) {
    w.ensure(80);
    w.y -= 52;
    const mark = sigs.find((x) => x.role === s.role);
    if (mark) {
      const img = await doc.embedPng(mark.png);
      const scale = Math.min(260 / img.width, 42 / img.height);
      w.page.drawImage(img, { x: M + 4, y: w.y + 3, width: img.width * scale, height: img.height * scale });
      w.text(mark.date, sigRight + 16, w.y + 8, 9.5);
    }
    w.rule(w.y, M, sigRight, MUTED);
    w.rule(w.y, sigRight + 12, right, MUTED);
    w.text(s.label, M + 4, w.y - 14, 9.5);
    w.text("Date", sigRight + 16, w.y - 14, 9.5);
    w.y -= 14;
  }
  if (b.consent) {
    w.y -= 18;
    w.paragraph(b.consent, 9.5, M, right - M, fonts.regular, MUTED, 1.9);
  }
}

function richText(w: Writer, title: string, nodes: RichNode[]) {
  const { fonts } = w;
  w.contentPage(title);
  for (const n of nodes) {
    if (n.kind === "heading") {
      w.ensure(40);
      w.y -= 10;
      w.paragraph(n.text, 10, M + 28, W - 2 * M - 28, fonts.bold);
      w.y -= 4;
    } else if (n.kind === "bullet") {
      w.paragraph(`- ${n.text}`, 10, M, W - 2 * M);
      w.y -= 6;
    } else {
      w.paragraph(n.text, 10, M, W - 2 * M);
      w.y -= 8;
    }
  }
}

async function attachments(w: Writer, b: Extract<RenderBlock, { type: "attachments" }>, opts: RenderOptions) {
  for (const f of b.files) {
    const file = await opts.loadFile(f.file_id);
    if (!file) {
      if (opts.strictHashes) throw new Error(`attachment ${f.filename} is missing`);
      continue;
    }
    if (opts.strictHashes && file.sha256 !== f.sha256) {
      throw new Error(`attachment ${f.filename} changed after the document was frozen`);
    }
    if (file.content_type === "application/pdf") {
      const src = await PDFDocument.load(file.bytes, { ignoreEncryption: true });
      const pages = await w.doc.copyPages(src, src.getPageIndices());
      for (const pg of pages) w.doc.addPage(pg);
    } else if (file.content_type === "image/png" || file.content_type === "image/jpeg") {
      const img = file.content_type === "image/png" ? await w.doc.embedPng(file.bytes) : await w.doc.embedJpg(file.bytes);
      const page = w.doc.addPage([W, H]);
      const s = Math.min((W - 2 * M) / img.width, (H - 2 * M) / img.height);
      page.drawImage(img, { x: (W - img.width * s) / 2, y: (H - img.height * s) / 2, width: img.width * s, height: img.height * s });
    }
  }
}

function certificate(w: Writer, a: AuditInfo, sigs: SignatureMark[]) {
  void sigs;
  const { fonts } = w;
  w.contentPage("Signature Certificate");
  const kv = (k: string, v: string) => {
    w.ensure(14);
    w.y -= 14;
    w.text(k, M, w.y, 9, fonts.bold, MUTED);
    for (const [i, line] of wrap(fonts.regular, v, 9, W - 2 * M - 130).entries()) {
      if (i) {
        w.ensure(12);
        w.y -= 12;
      }
      w.text(line, M + 130, w.y, 9);
    }
  };
  kv("Envelope", `#${a.envelope_id}`);
  kv("Document", w.model.proposal.name);
  kv("Document SHA-256", a.document_sha256);
  kv("Sent", `${a.created_at} UTC`);
  kv("Completed", `${a.completed_at} UTC`);
  w.y -= 10;
  for (const s of a.signers) {
    w.ensure(110);
    w.y -= 18;
    w.rule(w.y + 10);
    w.text(`${s.name} (${s.role})`, M, w.y - 4, 11, fonts.bold);
    w.y -= 6;
    kv("Email", s.email || "-");
    kv("Method", s.method);
    kv("Viewed", s.viewed_at ? `${s.viewed_at} UTC` : "-");
    kv("Signed", `${s.signed_at} UTC`);
    kv("IP address", s.ip || "-");
    kv("Device", s.user_agent || "-");
    kv("Consent", s.consent_text);
  }
  w.y -= 14;
  w.ensure(30);
  w.y -= 14;
  w.text("Event log", M, w.y, 11, fonts.bold);
  for (const e of a.events) {
    w.ensure(13);
    w.y -= 13;
    w.text(e.at, M, w.y, 8.5, fonts.regular, MUTED);
    w.text(e.event, M + 110, w.y, 8.5);
    w.text(e.who, M + 200, w.y, 8.5);
    w.text(e.ip, M + 400, w.y, 8.5, fonts.regular, MUTED);
  }
  w.y -= 20;
  w.paragraph(
    "Each signer agreed to sign electronically and adopted the signature shown in this document. The document SHA-256 fingerprints the exact content presented for signature; any change to it produces a different fingerprint.",
    8.5, M, W - 2 * M, fonts.italic, MUTED,
  );
}

// ── Entry point ───────────────────────────────────────────────────────

export async function renderProposalPdf(model: RenderModel, opts: RenderOptions): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(model.proposal.name);
  doc.setAuthor(model.branding.company_name);
  doc.setProducer("Roofline");
  doc.setCreator("Roofline");
  const fonts: Fonts = {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    italic: await doc.embedFont(StandardFonts.HelveticaOblique),
  };
  let logo: PDFImage | null = null;
  if (model.logo) {
    const f = await opts.loadFile(model.logo.file_id);
    if (f && (!opts.strictHashes || f.sha256 === model.logo.sha256)) {
      logo = f.content_type === "image/png" ? await doc.embedPng(f.bytes) : await doc.embedJpg(f.bytes);
    } else if (opts.strictHashes) {
      throw new Error("logo changed after the document was frozen");
    }
  }
  const w = new Writer(doc, fonts, model, hexColor(model.branding.accent), logo, Boolean(opts.preview));
  const sigs = opts.signatures ?? [];

  for (const b of model.blocks) {
    switch (b.type) {
      case "cover":
        cover(w, b.title);
        break;
      case "line_items":
        lineItems(w, b);
        break;
      case "summary":
        await summary(w, b, sigs);
        break;
      case "attachments":
        await attachments(w, b, opts);
        break;
      case "text":
        richText(w, b.title, b.nodes);
        break;
    }
  }
  if (opts.audit) certificate(w, opts.audit, sigs);
  if (doc.getPageCount() === 0) doc.addPage([W, H]);
  return doc.save();
}
