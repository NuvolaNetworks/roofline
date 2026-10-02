// The invoice document: one model, rendered to PDF here and to HTML by
// components/InvoiceDocument.tsx. The work scope comes from the SIGNED
// proposal (the frozen envelope snapshot) when there is one, so an invoice
// always bills exactly what the homeowner agreed to; an unsigned proposal
// falls back to its live lines.
import { PDFDocument, StandardFonts, rgb, type PDFImage } from "pdf-lib";
import type { Db } from "./db.ts";
import { fileLoader, loadProposalModel } from "./proposal-data.ts";
import { money, addressLines, type RenderModel } from "./proposal-model.ts";
import { safeText, wrap } from "./proposal-pdf.ts";
import { balanceDue, type InvoiceRow } from "./invoices.ts";

export interface InvoiceModel {
  number: string;
  title: string;
  status: string;
  issued_on: string;
  due_on: string;
  branding: RenderModel["branding"];
  logo: RenderModel["logo"];
  customer: RenderModel["customer"];
  rep: RenderModel["rep"];
  proposal_name: string;
  scope: Array<{ name: string; lines: Array<{ name: string; qty: string; unit: string }> }>;
  contract_cents: number;
  percent: number | null;
  amount_cents: number;
  paid_cents: number;
  balance_cents: number;
  billed_before_cents: number;
  paid_before_cents: number;
  payments: Array<{ received_on: string; method: string; amount_cents: number }>;
  notes: string;
}

const day = (ts: string | null | undefined) => {
  if (!ts) return "";
  const [y, m, d] = ts.slice(0, 10).split("-");
  return `${m}/${d}/${y}`;
};

export async function loadInvoiceModel(db: Db, orgId: string, inv: InvoiceRow): Promise<InvoiceModel | null> {
  if (!inv.proposal_id) return null;
  const env = await db.get<{ snapshot: string }>(
    "SELECT snapshot FROM signature_envelopes WHERE proposal_id = ? AND org_id = ? AND status = 'Completed' ORDER BY id DESC LIMIT 1",
    inv.proposal_id, orgId,
  );
  let model: RenderModel;
  if (env) {
    model = JSON.parse(env.snapshot) as RenderModel;
  } else {
    const live = await loadProposalModel(db, orgId, Number(inv.proposal_id), { id: 0, name: "", email: "" });
    if (!live) return null;
    model = live.model;
  }
  const items = model.blocks.find((b) => b.type === "line_items");
  const scope = items && items.type === "line_items"
    ? items.groups.map((g) => ({ name: g.name, lines: g.lines.map((l) => ({ name: l.name, qty: l.qty, unit: l.unit })) }))
    : [];
  const others = await db.get<{ billed: number; paid: number }>(
    `SELECT COALESCE(SUM(amount_cents),0) AS billed, COALESCE(SUM(amount_paid_cents),0) AS paid
     FROM invoices WHERE proposal_id = ? AND org_id = ? AND status != 'Void' AND id < ?`,
    inv.proposal_id, orgId, inv.id,
  );
  const payments = await db.all<{ received_on: string | null; received_at: string; method: string; amount_cents: number }>(
    "SELECT received_on, received_at, method, amount_cents FROM payments WHERE invoice_id = ? AND org_id = ? ORDER BY id",
    inv.id, orgId,
  );
  return {
    number: inv.number ?? `INV-${inv.id}`,
    title: inv.title ?? inv.kind,
    status: inv.status,
    issued_on: day(inv.sent_at ?? inv.created_at),
    due_on: day(inv.due_on) || "Upon receipt",
    branding: model.branding,
    logo: model.logo,
    customer: model.customer,
    rep: model.rep,
    proposal_name: model.proposal.name,
    scope,
    contract_cents: model.total_cents,
    percent: inv.percent === null || inv.percent === undefined ? null : Number(inv.percent),
    amount_cents: Number(inv.amount_cents),
    paid_cents: Number(inv.amount_paid_cents),
    balance_cents: balanceDue(inv),
    billed_before_cents: Number(others?.billed ?? 0),
    paid_before_cents: Number(others?.paid ?? 0),
    payments: payments.map((p) => ({ received_on: day(p.received_on ?? p.received_at), method: p.method, amount_cents: Number(p.amount_cents) })),
    notes: inv.notes ?? "",
  };
}

const W = 612;
const H = 792;
const M = 42;
const INK = rgb(0.16, 0.2, 0.24);
const MUTED = rgb(0.42, 0.45, 0.5);
const RULE = rgb(0.82, 0.83, 0.85);

function hex(h: string) {
  const n = parseInt(h.replace("#", ""), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

export async function renderInvoicePdf(db: Db, orgId: string, m: InvoiceModel): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`${m.number} — ${m.branding.company_name}`);
  doc.setProducer("Roofline");
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const accent = hex(m.branding.accent);
  let logo: PDFImage | null = null;
  if (m.logo) {
    const f = await fileLoader(db, orgId)(m.logo.file_id);
    if (f) logo = f.content_type === "image/png" ? await doc.embedPng(f.bytes) : await doc.embedJpg(f.bytes);
  }
  let page = doc.addPage([W, H]);
  let y = H - M;
  const text = (s: string, x: number, yy: number, size = 10, font = regular, color = INK) =>
    page.drawText(safeText(font, s), { x, y: yy, size, font, color });
  const right = (s: string, xr: number, yy: number, size = 10, font = regular, color = INK) => {
    const t = safeText(font, s);
    page.drawText(t, { x: xr - font.widthOfTextAtSize(t, size), y: yy, size, font, color });
  };
  const ensure = (h: number) => {
    if (y - h < M + 40) {
      page = doc.addPage([W, H]);
      y = H - M;
    }
  };

  // Header: logo (or company name on black) + INVOICE block.
  page.drawRectangle({ x: 0, y: H - 10, width: W, height: 10, color: accent });
  if (logo) {
    const s = Math.min(200 / logo.width, 60 / logo.height);
    page.drawImage(logo, { x: M, y: y - logo.height * s, width: logo.width * s, height: logo.height * s });
  } else {
    page.drawRectangle({ x: M, y: y - 44, width: 210, height: 44, color: rgb(0, 0, 0) });
    text(m.branding.company_name.toUpperCase(), M + 12, y - 27, 12, bold, rgb(1, 1, 1));
  }
  right("INVOICE", W - M, y - 18, 22, bold);
  right(m.number, W - M, y - 36, 11, regular, MUTED);
  y -= 82;

  // Bill to / dates.
  text("Bill to", M, y, 9, bold, MUTED);
  text("Issued", W - M - 170, y, 9, bold, MUTED);
  right(m.issued_on, W - M, y, 10);
  let by = y;
  for (const l of [m.customer.name, ...addressLines(m.customer.address), m.customer.email].filter(Boolean)) {
    by -= 14;
    text(l, M, by, 10.5);
  }
  text("Due", W - M - 170, y - 16, 9, bold, MUTED);
  right(m.due_on, W - M, y - 16, 10, bold);
  text("For", W - M - 170, y - 32, 9, bold, MUTED);
  const forLines = wrap(regular, m.proposal_name, 10, 150);
  forLines.forEach((l, i) => right(l, W - M, y - 32 - i * 13, 10));
  y = Math.min(by, y - 32 - forLines.length * 13) - 26;

  // This invoice.
  page.drawRectangle({ x: M, y: y - 52, width: W - 2 * M, height: 52, color: accent, opacity: 0.08 });
  text(m.title, M + 14, y - 22, 13, bold);
  text(
    m.percent !== null ? `${m.percent}% of the ${money(m.contract_cents)} contract` : `Toward the ${money(m.contract_cents)} contract`,
    M + 14, y - 38, 10, regular, MUTED,
  );
  right(money(m.amount_cents), W - M - 14, y - 28, 16, bold);
  y -= 76;

  // Summary table.
  const row = (label: string, value: string, strong = false) => {
    ensure(18);
    text(label, W / 2, y, 10, strong ? bold : regular, strong ? INK : MUTED);
    right(value, W - M, y, 10, strong ? bold : regular);
    y -= 17;
  };
  row("Contract total", money(m.contract_cents));
  if (m.billed_before_cents) row("Previously invoiced", money(m.billed_before_cents));
  if (m.paid_before_cents) row("Previously paid", money(m.paid_before_cents));
  row("This invoice", money(m.amount_cents));
  if (m.paid_cents) row("Paid on this invoice", `- ${money(m.paid_cents)}`);
  page.drawLine({ start: { x: W / 2, y: y + 9 }, end: { x: W - M, y: y + 9 }, thickness: 0.75, color: INK });
  y -= 4;
  row(m.balance_cents === 0 ? "Paid in full" : "Amount due", money(m.balance_cents), true);
  y -= 10;

  if (m.payments.length) {
    ensure(30);
    text("Payments received", M, y, 10, bold);
    y -= 16;
    for (const p of m.payments) {
      ensure(14);
      text(`${p.received_on}  ·  ${p.method}`, M, y, 9.5, regular, MUTED);
      right(money(p.amount_cents), W / 2 - 20, y, 9.5);
      y -= 13;
    }
    y -= 8;
  }

  // Scope of work (what's being billed).
  if (m.scope.length) {
    ensure(40);
    page.drawLine({ start: { x: M, y: y + 6 }, end: { x: W - M, y: y + 6 }, thickness: 0.75, color: RULE });
    y -= 10;
    text("Scope of work (per signed proposal)", M, y, 10, bold);
    y -= 16;
    for (const g of m.scope) {
      ensure(30);
      if (g.name) {
        text(g.name, M, y, 9.5, bold, INK);
        y -= 13;
      }
      for (const l of g.lines) {
        ensure(13);
        const name = wrap(regular, l.name, 9, W - 2 * M - 120)[0];
        text(name, M + 10, y, 9, regular, MUTED);
        right(`${l.qty} ${l.unit}`.trim(), W - M, y, 9, regular, MUTED);
        y -= 12;
      }
      y -= 4;
    }
  }

  const instructions = m.branding.payment_instructions.trim();
  if (instructions || m.notes.trim()) {
    ensure(70);
    y -= 8;
    page.drawLine({ start: { x: M, y: y + 6 }, end: { x: W - M, y: y + 6 }, thickness: 0.75, color: RULE });
    y -= 10;
    if (instructions) {
      text("How to pay", M, y, 10, bold);
      y -= 15;
      for (const para of instructions.split("\n")) {
        for (const l of wrap(regular, para || " ", 9.5, W - 2 * M)) {
          ensure(13);
          text(l, M, y, 9.5);
          y -= 13;
        }
      }
      y -= 6;
    }
    if (m.notes.trim()) {
      text("Notes", M, y, 10, bold);
      y -= 15;
      for (const l of wrap(regular, m.notes, 9.5, W - 2 * M)) {
        ensure(13);
        text(l, M, y, 9.5);
        y -= 13;
      }
    }
  }

  // Footer on every page.
  for (const p of doc.getPages()) {
    const footer = [m.branding.company_name, m.rep.name && `${m.rep.name}${m.rep.email ? ` · ${m.rep.email}` : ""}`, m.branding.phone]
      .filter(Boolean)
      .join("  ·  ");
    p.drawLine({ start: { x: M, y: 46 }, end: { x: W - M, y: 46 }, thickness: 0.5, color: RULE });
    p.drawText(safeText(regular, footer), { x: M, y: 32, size: 8.5, font: regular, color: MUTED });
  }
  return doc.save();
}
