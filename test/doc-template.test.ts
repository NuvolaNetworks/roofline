import test from "node:test";
import assert from "node:assert/strict";
import {
  defaultProposalTemplate,
  mergeFields,
  normalizeTemplate,
  parseRichText,
  parseTemplateBody,
} from "../lib/doc-template.ts";
import { addressLines, buildRenderModel, signerRoles } from "../lib/proposal-model.ts";
import { sampleInput } from "./fixtures/sample-proposal.ts";

test("a null or broken body falls back to the default layout", () => {
  for (const body of [null, "", "{not json", "42"]) {
    const t = parseTemplateBody(body, "Acme Roofing");
    assert.deepEqual(t.blocks.map((b) => b.type), ["cover", "line_items", "summary", "attachments", "text"]);
    assert.equal(t.branding.company_name, "Acme Roofing");
  }
});

test("normalize drops unknown blocks, clamps stats, fixes bad colours and duplicate ids", () => {
  const t = normalizeTemplate({
    branding: { accent: "red", stats: [1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: "x" })) },
    blocks: [
      { id: "a", type: "cover", title: "P" },
      { id: "a", type: "text", title: "T", body: "b" },
      { type: "script", body: "<script>" },
      { type: "attachments", file_ids: [3, 3, -1, "7", 9] },
    ],
  });
  assert.equal(t.branding.accent, "#C8102E");
  assert.equal(t.branding.stats.length, 4);
  assert.deepEqual(t.blocks.map((b) => b.type), ["cover", "text", "attachments"]);
  assert.notEqual(t.blocks[0].id, t.blocks[1].id);
  const att = t.blocks[2];
  assert.ok(att.type === "attachments");
  assert.deepEqual(att.file_ids, [3, 9]);
});

test("merge fields fill known keys and blank unknown ones", () => {
  assert.equal(
    mergeFields("Hi {{ customer.name }} from {{company.name}}{{nope}}", { "customer.name": "Jo", "company.name": "8 Square" }),
    "Hi Jo from 8 Square",
  );
});

test("rich text: headings, bullets, paragraphs", () => {
  const nodes = parseRichText("Intro line one\nline two\n\n## 1. SCOPE\n- first\n· second\n\nClosing");
  assert.deepEqual(nodes, [
    { kind: "paragraph", text: "Intro line one line two" },
    { kind: "heading", text: "1. SCOPE" },
    { kind: "bullet", text: "first" },
    { kind: "bullet", text: "second" },
    { kind: "paragraph", text: "Closing" },
  ]);
});

test("render model groups lines by section in order and totals them", () => {
  const model = buildRenderModel(sampleInput());
  const items = model.blocks.find((b) => b.type === "line_items");
  assert.ok(items && items.type === "line_items");
  assert.deepEqual(items.groups.map((g) => g.name), [
    "Work Scope", "Malarkey Roofing Section", "Roofing Accessories Section",
    "Ventilation & Flashing Section", "Decking", "Clean Up",
  ]);
  const vista = items.groups[1].lines[0];
  assert.equal(vista.qty, "103");
  assert.equal(vista.unit, "Bundle");
  assert.deepEqual(vista.notes, ["- FREE UPGRADE", "- Class 4 - Color: Weatherwood Plus"]);
  assert.equal(items.show_prices, false);
  const expected = sampleInput().lines.reduce((s, l) => s + Math.round(l.qty * l.unit_price_cents), 0);
  assert.equal(model.total_cents, expected);
  const summary = model.blocks.find((b) => b.type === "summary");
  assert.ok(summary && summary.type === "summary");
  assert.match(summary.consent, /8 Square Roofing & Construction/);
  assert.deepEqual(signerRoles(model).map((s) => s.role), ["customer", "contractor"]);
});

test("contractor signature is optional per template", () => {
  const input = sampleInput();
  const s = input.template.blocks.find((b) => b.type === "summary");
  assert.ok(s && s.type === "summary");
  s.contractor_signs = false;
  assert.deepEqual(signerRoles(buildRenderModel(input)).map((x) => x.role), ["customer"]);
});

test("attachments: catalogue specs + listed files, deduped; empty block omitted", () => {
  const spec = { file_id: 5, filename: "vista.pdf", sha256: "a" };
  const listed = { file_id: 6, filename: "boot.pdf", sha256: "b" };
  const input = sampleInput({ catalogueSpecs: [spec], files: new Map([[5, spec], [6, listed]]) });
  const att = input.template.blocks.find((b) => b.type === "attachments");
  assert.ok(att && att.type === "attachments");
  att.file_ids = [5, 6];
  const block = buildRenderModel(input).blocks.find((b) => b.type === "attachments");
  assert.ok(block && block.type === "attachments");
  assert.deepEqual(block.files.map((f) => f.file_id), [5, 6]);
  const none = buildRenderModel(sampleInput());
  assert.equal(none.blocks.some((b) => b.type === "attachments"), false);
});

test("address lines split street from city", () => {
  assert.deepEqual(addressLines("1 Main St, Manchaca, TX 78652"), ["1 Main St", "Manchaca, TX 78652"]);
  assert.deepEqual(addressLines("Austin, TX"), ["Austin, TX"]);
});

test("the default template parses back to itself", () => {
  const t = defaultProposalTemplate("X");
  assert.deepEqual(parseTemplateBody(JSON.stringify(t), "X"), t);
});
