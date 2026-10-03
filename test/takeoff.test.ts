/**
 * Blueprint takeoffs: the extraction schema per trade, normalizing a model
 * reply, a failed read that can be fixed by hand, review → approve → a
 * proposal (roofing via the measurement builder; pools priced from mapped
 * catalog SKUs), and the signed AMOS extract client (PDF splitting,
 * request shape, errors surfaced).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument } from "pdf-lib";
import { createSqliteDb } from "../lib/db-sqlite.ts";
import { DEMO_ORG_ID } from "../lib/demo-fixtures.ts";
import { putFile } from "../lib/files.ts";
import {
  approveTakeoff,
  createTakeoff,
  extractionSchema,
  FIELDS,
  getTakeoff,
  normalizeExtraction,
  runExtraction,
  saveReview,
  type Extractor,
} from "../lib/takeoff.ts";
import { amosExtractor, extractUrl, splitPdf } from "../lib/amos-extract.ts";

process.env.ROOFLINE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "roofline-takeoff-")), "t.db");
const db = createSqliteDb();
const org = DEMO_ORG_ID;
const actor = { id: null, name: "Test", email: "" };

async function pdf(pages = 1): Promise<Uint8Array> {
  const d = await PDFDocument.create();
  for (let i = 0; i < pages; i++) d.addPage([612, 792]).drawText(`Sheet A-${i + 1}`, { x: 50, y: 700 });
  return d.save();
}

async function job(): Promise<number> {
  return Number((await db.get<{ id: number }>("SELECT id FROM jobs WHERE org_id = ? ORDER BY id LIMIT 1", org))!.id);
}

const v = (value: number | null, confidence = "high") => ({ value, sheet: "A-3 Roof Plan", confidence, note: "" });

test("the schema names every field of the trade and asks for sheet + confidence", () => {
  for (const trade of ["roofing", "pool", "construction"] as const) {
    const s = extractionSchema(trade) as any;
    assert.deepEqual(s.properties.values.required, FIELDS[trade].map((f) => f.key));
    assert.deepEqual(s.properties.values.properties[FIELDS[trade][0].key].required, ["value", "sheet", "confidence", "note"]);
  }
});

test("a model reply is coerced: unknown keys dropped, junk and negatives become null", () => {
  const e = normalizeExtraction("roofing", {
    values: { total_squares: { value: "31.4", sheet: "A-3", confidence: "high", note: "" }, ridge_ft: { value: -5 }, bogus: { value: 9 } },
    scale: "1/4\" = 1'-0\"",
    warnings: ["Rear elevation missing"],
  });
  assert.equal(e.values.total_squares.value, 31.4);
  assert.equal(e.values.ridge_ft.value, null);
  assert.equal(e.values.hip_ft.value, null);
  assert.equal(e.values.hip_ft.confidence, "low");
  assert.ok(!("bogus" in e.values));
  assert.deepEqual(e.warnings, ["Rear elevation missing"]);
});

test("roofing: read → review → approve drafts the proposal from a blueprint measurement", async () => {
  const jobId = await job();
  const file = await putFile(db, org, "blueprint", "plans.pdf", await pdf());
  const id = await createTakeoff(db, org, jobId, file.id, "roofing", null);
  const extract: Extractor = async (input) => {
    assert.equal(input.contentType, "application/pdf");
    assert.match(input.instructions, /pitch-adjusted/);
    return { values: { total_squares: v(31.4), pitch: v(6), ridge_ft: v(48), eave_ft: v(160, "medium"), rake_ft: v(90) }, scale: "1/4\" = 1'", sheets_read: ["A-3"], warnings: [] };
  };
  const read = await runExtraction(db, org, id, extract);
  assert.equal(read.status, "Review");
  assert.equal(read.reviewed!.total_squares, 31.4);

  await saveReview(db, org, id, { ...read.reviewed, total_squares: "32", ridge_ft: "50" });
  const { proposal_id } = await approveTakeoff(db, org, id, actor);
  const m = await db.get<{ provider: string; total_squares: number; ridge_ft: number; pitch: string }>(
    "SELECT provider, total_squares, ridge_ft, pitch FROM measurements WHERE job_id = ? ORDER BY id DESC LIMIT 1", jobId,
  );
  assert.deepEqual({ ...m }, { provider: "blueprint", total_squares: 32, ridge_ft: 50, pitch: "6/12" });
  const p = await db.get<{ name: string }>("SELECT name FROM proposals WHERE id = ?", proposal_id);
  assert.match(p!.name, /32 sq/);
  assert.equal((await getTakeoff(db, org, id))!.status, "Approved");
  await assert.rejects(saveReview(db, org, id, {}), /already approved/);
  assert.deepEqual(await approveTakeoff(db, org, id, actor), { proposal_id }, "approving twice returns the same proposal");
});

test("a failed read says why, and numbers entered by hand still approve", async () => {
  const file = await putFile(db, org, "blueprint", "plans.pdf", await pdf());
  const id = await createTakeoff(db, org, await job(), file.id, "roofing", null);
  const failed = await runExtraction(db, org, id, async () => {
    throw new Error("AMOS couldn't read the plans: rate limited");
  });
  assert.equal(failed.status, "Failed");
  assert.match(failed.error!, /rate limited/);
  await assert.rejects(approveTakeoff(db, org, id, actor), /roof area/);
  await saveReview(db, org, id, { total_squares: "25", pitch: "8" });
  assert.equal((await getTakeoff(db, org, id))!.status, "Review");
  await assert.rejects(saveReview(db, org, id, { total_squares: "lots" }), /must be a number/);
  assert.ok((await approveTakeoff(db, org, id, actor)).proposal_id > 0);
});

test("pool: mapped catalog SKUs price the lines; unmapped quantities wait at $0", async () => {
  await db.run(
    "INSERT INTO catalogue (org_id, sku, name, unit, price_cents, cost_cents, section, source) VALUES (?,?,?,?,?,?,?,?)",
    org, "POOL-COPING-LF", "Travertine coping", "lf", 4500, 2800, "Hardscape", "custom",
  );
  const file = await putFile(db, org, "blueprint", "pool.pdf", await pdf());
  const id = await createTakeoff(db, org, await job(), file.id, "pool", null);
  await runExtraction(db, org, id, async () => ({ values: { coping_lf: v(96), decking_sqft: v(600), surface_area_sqft: v(512) } }));
  const { proposal_id } = await approveTakeoff(db, org, id, actor);
  const lines = await db.all<{ sku: string; qty: number; unit_price_cents: number; section: string }>(
    "SELECT sku, qty, unit_price_cents, section FROM proposal_lines WHERE proposal_id = ? ORDER BY position", proposal_id,
  );
  const coping = lines.find((l) => l.sku === "POOL-COPING-LF")!;
  assert.deepEqual({ qty: coping.qty, price: coping.unit_price_cents, section: coping.section }, { qty: 96, price: 4500, section: "Hardscape" });
  const deck = lines.find((l) => l.sku === "POOL-DECK-SF")!;
  assert.equal(deck.unit_price_cents, 0);
  assert.match(deck.section, /price before sending/);
});

test("large PDFs split into page ranges under the limit; the client signs and surfaces errors", async () => {
  const many = await pdf(6);
  const limit = Math.ceil(many.length * 0.7);
  const chunks = await splitPdf(many, limit);
  assert.ok(chunks.length >= 2);
  let pages = 0;
  for (const c of chunks) {
    assert.ok(c.length <= limit);
    pages += (await PDFDocument.load(c)).getPageCount();
  }
  assert.equal(pages, 6);
  await assert.rejects(splitPdf(many, limit, 1), /too large to read at once/);

  assert.equal(extractUrl({ AMOS_APP_SERVICES_URL: "https://p.example/api/v1/app-services/messages" }), "https://p.example/api/v1/app-services/extract");
  await db.run("UPDATE orgs SET amos_tenant_id = ? WHERE id = ?", "aa193fa0-2229-415e-a609-35076a8afb01", org);
  const env = { AMOS_APP_AUTH_APP_ID: "082c7568-54f5-41d5-be39-4e4a99afc700", AMOS_APP_SERVICES_URL: "https://p.example/api/v1/app-services/messages" };
  let seen: any = null;
  const ok = amosExtractor(db, {
    env,
    fetchImpl: (async (url: string, init: RequestInit) => {
      seen = { url, auth: (init.headers as Record<string, string>).authorization, body: JSON.parse(String(init.body)) };
      return new Response(JSON.stringify({ status: "ok", result: { values: {} } }), { status: 200 });
    }) as unknown as typeof fetch,
  });
  const doc = await pdf();
  assert.deepEqual(await ok({ orgId: org, document: doc, contentType: "application/pdf", filename: "Roof Plan.pdf", instructions: "read", schema: { type: "object" } }), { values: {} });
  assert.equal(seen.url, "https://p.example/api/v1/app-services/extract");
  assert.match(seen.auth, /^Bearer ey/);
  assert.equal(seen.body.org_id, "aa193fa0-2229-415e-a609-35076a8afb01");
  assert.equal(seen.body.purpose, "blueprint_takeoff");
  assert.equal(seen.body.documents[0].filename, "Roof Plan");
  assert.equal(Buffer.from(seen.body.documents[0].data, "base64").length, doc.length);

  const refused = amosExtractor(db, {
    env,
    fetchImpl: (async () => new Response(JSON.stringify({ error: "too many document reads this hour; retry later", code: "rate_limited" }), { status: 429 })) as unknown as typeof fetch,
  });
  await assert.rejects(refused({ orgId: org, document: doc, contentType: "application/pdf", filename: "x.pdf", instructions: "read", schema: {} }), /too many document reads/);
});
