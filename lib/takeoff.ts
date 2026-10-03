// Blueprint takeoffs: plans in, reviewed quantities out, then a proposal.
//
// AMOS reads the plans (the governed `app_document_extract` call) into the
// typed fields below for the job's trade. Every value carries the sheet it
// came from and a confidence, because a blueprint read is advice: a person
// reviews and corrects each number, and only APPROVING prices anything.
// Roofing approval writes a measurement and reuses the measurement →
// proposal builder; pools and new construction get a quantity proposal
// priced from catalog items mapped by SKU (unmapped quantities land at $0,
// flagged to price before sending).
import type { Db } from "./db.ts";
import { getFile } from "./files.ts";
import { buildProposalFromMeasurement, type Actor } from "./proposal-ops.ts";
import { logJobEvent, recalcProposal } from "./proposal-effects.ts";

export class TakeoffError extends Error {}

export const TRADES = ["roofing", "pool", "construction"] as const;
export type Trade = (typeof TRADES)[number];

export interface TakeoffField {
  key: string;
  label: string;
  unit: string;
  /** Catalog SKU this quantity prices against (pool/construction). */
  sku?: string;
  /** A count rather than a measurement. */
  count?: boolean;
}

export const FIELDS: Record<Trade, TakeoffField[]> = {
  roofing: [
    { key: "total_squares", label: "Roof area (squares, pitch-adjusted)", unit: "sq" },
    { key: "pitch", label: "Predominant pitch (x/12)", unit: "/12" },
    { key: "ridge_ft", label: "Ridge", unit: "ft" },
    { key: "hip_ft", label: "Hip", unit: "ft" },
    { key: "valley_ft", label: "Valley", unit: "ft" },
    { key: "eave_ft", label: "Eave", unit: "ft" },
    { key: "rake_ft", label: "Rake", unit: "ft" },
    { key: "penetrations", label: "Penetrations (vents, stacks, skylights)", unit: "each", count: true },
    { key: "stories", label: "Stories", unit: "", count: true },
  ],
  pool: [
    { key: "surface_area_sqft", label: "Pool surface area", unit: "sq ft", sku: "POOL-SHELL-SF" },
    { key: "perimeter_ft", label: "Pool perimeter", unit: "ft" },
    { key: "length_ft", label: "Length", unit: "ft" },
    { key: "width_ft", label: "Width", unit: "ft" },
    { key: "shallow_depth_ft", label: "Shallow depth", unit: "ft" },
    { key: "deep_depth_ft", label: "Deep depth", unit: "ft" },
    { key: "volume_gal", label: "Volume", unit: "gal" },
    { key: "coping_lf", label: "Coping", unit: "lf", sku: "POOL-COPING-LF" },
    { key: "tile_lf", label: "Waterline tile", unit: "lf", sku: "POOL-TILE-LF" },
    { key: "decking_sqft", label: "Decking", unit: "sq ft", sku: "POOL-DECK-SF" },
    { key: "spa_perimeter_ft", label: "Spa perimeter (0 if none)", unit: "ft", sku: "POOL-SPA-LF" },
    { key: "steps", label: "Steps / benches", unit: "each", count: true, sku: "POOL-STEP-EA" },
  ],
  construction: [
    { key: "conditioned_sqft", label: "Conditioned area", unit: "sq ft", sku: "NC-BUILD-SF" },
    { key: "footprint_sqft", label: "Footprint (slab)", unit: "sq ft", sku: "NC-SLAB-SF" },
    { key: "foundation_perimeter_ft", label: "Foundation perimeter", unit: "ft", sku: "NC-FOOTING-LF" },
    { key: "exterior_wall_lf", label: "Exterior walls", unit: "lf", sku: "NC-EXTWALL-LF" },
    { key: "wall_height_ft", label: "Wall height", unit: "ft" },
    { key: "interior_wall_lf", label: "Interior walls", unit: "lf", sku: "NC-INTWALL-LF" },
    { key: "windows", label: "Windows", unit: "each", count: true, sku: "NC-WINDOW-EA" },
    { key: "exterior_doors", label: "Exterior doors", unit: "each", count: true, sku: "NC-EXTDOOR-EA" },
    { key: "interior_doors", label: "Interior doors", unit: "each", count: true, sku: "NC-INTDOOR-EA" },
    { key: "roof_squares", label: "Roof area (squares)", unit: "sq", sku: "NC-ROOF-SQ" },
    { key: "stories", label: "Stories", unit: "", count: true },
  ],
};

export interface ExtractedValue {
  value: number | null;
  sheet: string;
  confidence: "high" | "medium" | "low";
  note: string;
}

export interface Extraction {
  values: Record<string, ExtractedValue>;
  scale: string;
  sheets_read: string[];
  warnings: string[];
}

const TRADE_GUIDANCE: Record<Trade, string> = {
  roofing:
    "These are construction plans for a ROOF job. Use the roof plan and elevations. Report total_squares as the pitch-adjusted SURFACE area in squares (1 square = 100 sq ft): if a plan shows horizontal (plan-view) area, multiply each plane by its pitch factor (sqrt(1 + (rise/12)^2)) before summing. pitch is the predominant rise per 12 (e.g. 6 for 6/12). Linear measures in feet.",
  pool:
    "These are plans for a POOL. Use the pool plan, sections and details. surface_area_sqft is the water surface. coping_lf and tile_lf usually equal the perimeter (plus spa). volume_gal = surface area × average depth × 7.48 if not stated. Decking is the hardscape around the pool.",
  construction:
    "These are plans for NEW CONSTRUCTION. Use the floor plans, foundation plan, roof plan and schedules (window/door schedules for counts). Areas in sq ft, walls in linear feet, roof_squares as pitch-adjusted surface area in squares.",
};

/** The JSON schema the extraction must satisfy, per trade. */
export function extractionSchema(trade: Trade): Record<string, unknown> {
  const valueSchema = {
    type: "object",
    properties: {
      value: { type: ["number", "null"] },
      sheet: { type: "string", description: "Sheet/page the number came from, e.g. 'A-3 Roof Plan' or 'page 4'." },
      confidence: { type: "string", enum: ["high", "medium", "low"] },
      note: { type: "string", description: "How it was measured or why it is uncertain." },
    },
    required: ["value", "sheet", "confidence", "note"],
  };
  return {
    type: "object",
    properties: {
      values: {
        type: "object",
        properties: Object.fromEntries(FIELDS[trade].map((f) => [f.key, { ...valueSchema, description: `${f.label} (${f.unit || "number"})` }])),
        required: FIELDS[trade].map((f) => f.key),
      },
      scale: { type: "string", description: "The drawing scale used, e.g. '1/4\" = 1\\'-0\"', or 'not found'." },
      sheets_read: { type: "array", items: { type: "string" } },
      warnings: { type: "array", items: { type: "string" }, description: "Anything a reviewer must check: unclear scale, missing sheets, assumptions." },
    },
    required: ["values", "scale", "sheets_read", "warnings"],
  };
}

export function extractionInstructions(trade: Trade): string {
  return [
    "You are a construction estimator doing a quantity takeoff from blueprints.",
    TRADE_GUIDANCE[trade],
    "Only report numbers you can read or compute from the drawings; use null when a value cannot be determined, never a guess presented as fact.",
    "Use dimensions written on the plans first; scale from the drawing only when no dimension is given, and say so in the note with confidence 'low' or 'medium'.",
    "Name the sheet each value came from. List every assumption a reviewer should check in warnings.",
  ].join("\n");
}

/** Coerce a model reply into the trade's fields; unknown keys are dropped,
 *  non-numbers become null, and missing fields are present as null. */
export function normalizeExtraction(trade: Trade, raw: unknown): Extraction {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const vals = (r.values && typeof r.values === "object" ? r.values : {}) as Record<string, unknown>;
  const values: Record<string, ExtractedValue> = {};
  for (const f of FIELDS[trade]) {
    const v = (vals[f.key] && typeof vals[f.key] === "object" ? vals[f.key] : {}) as Record<string, unknown>;
    const n = typeof v.value === "number" ? v.value : typeof v.value === "string" ? Number(v.value) : NaN;
    const conf = v.confidence === "high" || v.confidence === "medium" ? v.confidence : "low";
    values[f.key] = {
      value: Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null,
      sheet: String(v.sheet ?? "").slice(0, 120),
      confidence: conf,
      note: String(v.note ?? "").slice(0, 400),
    };
  }
  const list = (x: unknown) => (Array.isArray(x) ? x.map((s) => String(s).slice(0, 300)).slice(0, 30) : []);
  return { values, scale: String(r.scale ?? "not found").slice(0, 120), sheets_read: list(r.sheets_read), warnings: list(r.warnings) };
}

/** What reading a blueprint needs: the platform call, injected so tests and
 *  orgs without AMOS can stub it. */
export type Extractor = (input: {
  orgId: string;
  document: Uint8Array;
  contentType: string;
  filename: string;
  instructions: string;
  schema: Record<string, unknown>;
}) => Promise<unknown>;

export async function createTakeoff(
  db: Db,
  orgId: string,
  jobId: number,
  fileId: number,
  trade: Trade,
  createdBy: number | null,
): Promise<number> {
  if (!TRADES.includes(trade)) throw new TakeoffError("Choose roofing, pool or new construction.");
  const r = await db.run(
    "INSERT INTO takeoffs (org_id, job_id, file_id, trade, status, created_by) VALUES (?,?,?,?, 'Reading', ?)",
    orgId, jobId, fileId, trade, createdBy,
  );
  return r.lastId;
}

export interface TakeoffRow {
  id: number;
  job_id: number;
  file_id: number;
  trade: Trade;
  status: "Reading" | "Review" | "Approved" | "Failed";
  extracted: Extraction | null;
  reviewed: Record<string, number | null> | null;
  error: string | null;
  proposal_id: number | null;
  created_at: string;
}

export async function getTakeoff(db: Db, orgId: string, id: number): Promise<TakeoffRow | null> {
  const r = await db.get<Record<string, unknown>>("SELECT * FROM takeoffs WHERE id = ? AND org_id = ?", id, orgId);
  if (!r) return null;
  return {
    id: Number(r.id),
    job_id: Number(r.job_id),
    file_id: Number(r.file_id),
    trade: r.trade as Trade,
    status: r.status as TakeoffRow["status"],
    extracted: r.extracted ? (JSON.parse(String(r.extracted)) as Extraction) : null,
    reviewed: r.reviewed ? (JSON.parse(String(r.reviewed)) as Record<string, number | null>) : null,
    error: r.error ? String(r.error) : null,
    proposal_id: r.proposal_id === null || r.proposal_id === undefined ? null : Number(r.proposal_id),
    created_at: String(r.created_at),
  };
}

/** Read the plans. On success the takeoff waits for review; on failure it
 *  says why, and the rep can retry or enter numbers by hand. */
export async function runExtraction(db: Db, orgId: string, takeoffId: number, extract: Extractor): Promise<TakeoffRow> {
  const t = await getTakeoff(db, orgId, takeoffId);
  if (!t) throw new TakeoffError("Takeoff not found.");
  const file = await getFile(db, orgId, t.file_id);
  if (!file) throw new TakeoffError("The blueprint file is missing.");
  try {
    const raw = await extract({
      orgId,
      document: file.bytes,
      contentType: file.content_type,
      filename: file.filename,
      instructions: extractionInstructions(t.trade),
      schema: extractionSchema(t.trade),
    });
    const extraction = normalizeExtraction(t.trade, raw);
    const reviewed = Object.fromEntries(Object.entries(extraction.values).map(([k, v]) => [k, v.value]));
    await db.run(
      "UPDATE takeoffs SET status = 'Review', extracted = ?, reviewed = ?, error = NULL, updated_at = datetime('now') WHERE id = ? AND org_id = ?",
      JSON.stringify(extraction), JSON.stringify(reviewed), takeoffId, orgId,
    );
  } catch (e) {
    await db.run(
      "UPDATE takeoffs SET status = 'Failed', error = ?, updated_at = datetime('now') WHERE id = ? AND org_id = ?",
      (e instanceof Error ? e.message : String(e)).slice(0, 500), takeoffId, orgId,
    );
  }
  return (await getTakeoff(db, orgId, takeoffId))!;
}

/** Save a reviewer's corrections (numbers only; blanks become null). */
export async function saveReview(db: Db, orgId: string, takeoffId: number, values: Record<string, unknown>): Promise<void> {
  const t = await getTakeoff(db, orgId, takeoffId);
  if (!t) throw new TakeoffError("Takeoff not found.");
  if (t.status === "Approved") throw new TakeoffError("This takeoff is already approved.");
  const reviewed: Record<string, number | null> = {};
  for (const f of FIELDS[t.trade]) {
    const raw = String(values[f.key] ?? "").replace(/[,\s]/g, "");
    const n = raw === "" ? null : Number(raw);
    if (n !== null && !(Number.isFinite(n) && n >= 0)) throw new TakeoffError(`${f.label} must be a number.`);
    reviewed[f.key] = n === null ? null : Math.round(n * 100) / 100;
  }
  await db.run(
    "UPDATE takeoffs SET reviewed = ?, status = CASE WHEN status = 'Failed' THEN 'Review' ELSE status END, updated_at = datetime('now') WHERE id = ? AND org_id = ?",
    JSON.stringify(reviewed), takeoffId, orgId,
  );
}

/** Approve the reviewed numbers and draft the proposal from them. */
export async function approveTakeoff(db: Db, orgId: string, takeoffId: number, actor: Actor): Promise<{ proposal_id: number }> {
  const t = await getTakeoff(db, orgId, takeoffId);
  if (!t) throw new TakeoffError("Takeoff not found.");
  if (t.status === "Approved" && t.proposal_id) return { proposal_id: t.proposal_id };
  const v = t.reviewed ?? {};
  let proposalId: number;
  let measurementId: number | null = null;
  if (t.trade === "roofing") {
    const squares = v.total_squares;
    if (!squares || squares <= 0) throw new TakeoffError("Enter the roof area in squares before approving.");
    const m = await db.run(
      `INSERT INTO measurements (org_id, job_id, provider, status, total_squares, ridge_ft, hip_ft, valley_ft, eave_ft, rake_ft, pitch)
       VALUES (?,?, 'blueprint', 'delivered', ?,?,?,?,?,?,?)`,
      orgId, t.job_id, squares, v.ridge_ft ?? null, v.hip_ft ?? null, v.valley_ft ?? null, v.eave_ft ?? null, v.rake_ft ?? null,
      v.pitch === null || v.pitch === undefined ? null : `${v.pitch}/12`,
    );
    measurementId = m.lastId;
    proposalId = await buildProposalFromMeasurement(db, orgId, t.job_id, actor);
  } else {
    proposalId = await quantityProposal(db, orgId, t, v);
  }
  await db.run(
    `UPDATE takeoffs SET status = 'Approved', proposal_id = ?, measurement_id = ?, approved_by = ?, updated_at = datetime('now')
      WHERE id = ? AND org_id = ?`,
    proposalId, measurementId, actor.id, takeoffId, orgId,
  );
  await logJobEvent(db, orgId, t.job_id, "system", `Blueprint takeoff approved (${t.trade}) — proposal drafted`, actor.name);
  return { proposal_id: proposalId };
}

async function quantityProposal(db: Db, orgId: string, t: TakeoffRow, v: Record<string, number | null>): Promise<number> {
  const job = await db.get<{ title: string }>("SELECT title FROM jobs WHERE id = ? AND org_id = ?", t.job_id, orgId);
  const label = t.trade === "pool" ? "Pool" : "New construction";
  const p = await db.run(
    "INSERT INTO proposals (org_id, job_id, name, status) VALUES (?,?,?, 'Draft')",
    orgId, t.job_id, `${label} — ${job?.title ?? "from blueprints"}`.slice(0, 160),
  );
  const skus = FIELDS[t.trade].map((f) => f.sku).filter((s): s is string => Boolean(s));
  const cat = new Map(
    (
      await db.all<{ sku: string; name: string; unit: string; price_cents: number; cost_cents: number; section: string }>(
        `SELECT sku, name, unit, price_cents, cost_cents, section FROM catalogue WHERE org_id = ? AND sku IN (${skus.map(() => "?").join(",")})`,
        orgId, ...skus,
      )
    ).map((r) => [r.sku, r]),
  );
  let position = 0;
  for (const f of FIELDS[t.trade]) {
    const qty = v[f.key];
    if (!f.sku || !qty || qty <= 0) continue;
    const item = cat.get(f.sku);
    await db.run(
      `INSERT INTO proposal_lines (org_id, proposal_id, sku, name, unit, qty, unit_price_cents, unit_cost_cents, section, notes, position)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      orgId, p.lastId, f.sku, item?.name ?? f.label, item?.unit ?? f.unit, qty,
      Number(item?.price_cents ?? 0), Number(item?.cost_cents ?? 0),
      item?.section || (item ? "Scope" : "From blueprints — price before sending"),
      item ? "Quantity from blueprint takeoff" : `Quantity from blueprint takeoff; add catalog item ${f.sku} to price it automatically`,
      ++position,
    );
  }
  await recalcProposal(db, orgId, p.lastId);
  return p.lastId;
}
