import test from "node:test";
import assert from "node:assert/strict";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { buildRenderModel } from "../lib/proposal-model.ts";
import { renderProposalPdf, safeText, wrap } from "../lib/proposal-pdf.ts";
import { sha256Hex, sniffContentType } from "../lib/files.ts";
import { sampleInput } from "./fixtures/sample-proposal.ts";
import { makePng } from "./fixtures/png.ts";

test("renders the sample proposal: cover, estimate, summary, terms", async () => {
  const pdf = await renderProposalPdf(buildRenderModel(sampleInput()), { loadFile: async () => null });
  const doc = await PDFDocument.load(pdf);
  assert.ok(doc.getPageCount() >= 4);
  assert.equal(sniffContentType(pdf), "application/pdf");
});

test("attachment PDFs are appended; strict mode refuses changed bytes", async () => {
  const att = await PDFDocument.create();
  att.addPage();
  att.addPage();
  const bytes = await att.save();
  const ref = { file_id: 9, filename: "spec.pdf", sha256: sha256Hex(bytes) };
  const input = sampleInput({ catalogueSpecs: [ref], files: new Map([[9, ref]]) });
  const model = buildRenderModel(input);
  const loadFile = async () => ({ bytes, content_type: "application/pdf", sha256: sha256Hex(bytes) });
  const base = await PDFDocument.load(await renderProposalPdf(buildRenderModel(sampleInput()), { loadFile: async () => null }));
  const withAtt = await PDFDocument.load(await renderProposalPdf(model, { loadFile }));
  assert.equal(withAtt.getPageCount(), base.getPageCount() + 2);

  const tampered = async () => ({ bytes, content_type: "application/pdf", sha256: "different" });
  await assert.rejects(renderProposalPdf(model, { loadFile: tampered, strictHashes: true }), /changed/);
});

test("signatures and the certificate page render", async () => {
  const model = buildRenderModel(sampleInput());
  const base = await PDFDocument.load(await renderProposalPdf(model, { loadFile: async () => null }));
  const pdf = await renderProposalPdf(model, {
    loadFile: async () => null,
    signatures: [{ role: "customer", name: "Jordan Sample", png: makePng(), date: "10/02/2026" }],
    audit: {
      envelope_id: 1, document_sha256: "f".repeat(64), created_at: "2026-10-01 10:00:00", completed_at: "2026-10-02 10:00:00",
      signers: [{ role: "customer", name: "Jordan Sample", email: "j@example.com", method: "Drawn signature", ip: "203.0.113.9", user_agent: "Safari", viewed_at: "x", signed_at: "y", consent_text: "I agree" }],
      events: [{ at: "2026-10-02 10:00:00", event: "signed", who: "Jordan Sample", ip: "203.0.113.9" }],
    },
  });
  assert.equal((await PDFDocument.load(pdf)).getPageCount(), base.getPageCount() + 1);
});

test("text outside WinAnsi never crashes the renderer", async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  assert.equal(safeText(font, "Roof “A” — 5′ ✓"), "Roof “A” — 5' ?");
  const lines = wrap(font, "x".repeat(400), 10, 100);
  assert.ok(lines.length > 1 && lines.every((l) => font.widthOfTextAtSize(l, 10) <= 100));
});
