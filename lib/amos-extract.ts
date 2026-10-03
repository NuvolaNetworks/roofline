// Reading documents through AMOS: the signed `/app-services/extract` call.
// Roofline holds no model credentials; it sends the plans, the instructions
// and the JSON Schema it wants, signed with its registered service key, and
// gets one JSON object back (metered and receipted on the AMOS side).
// Bedrock reads at most 4.5 MB per PDF and five documents per request, so a
// large plan set is split into page ranges first.
import { PDFDocument } from "pdf-lib";
import type { Db } from "./db.ts";
import { appId, servicesUrl, serviceKey, signServiceToken } from "./amos-link.ts";
import type { Extractor } from "./takeoff.ts";

export const MAX_CHUNK_BYTES = 4_400_000;
export const MAX_CHUNKS = 5;
export const MAX_IMAGE_BYTES = 3_750_000;

export class ExtractError extends Error {}

export function extractUrl(env: Record<string, string | undefined> = process.env): string {
  return servicesUrl(env).replace(/\/messages$/, "/extract");
}

/** Split a PDF into consecutive page ranges that each fit Bedrock's limit. */
export async function splitPdf(bytes: Uint8Array, maxBytes = MAX_CHUNK_BYTES, maxChunks = MAX_CHUNKS): Promise<Uint8Array[]> {
  if (bytes.length <= maxBytes) return [bytes];
  const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const pages = src.getPageIndices();
  const build = async (indices: number[]) => {
    const out = await PDFDocument.create();
    for (const p of await out.copyPages(src, indices)) out.addPage(p);
    return out.save();
  };
  const chunks: Uint8Array[] = [];
  let current: number[] = [];
  let currentBytes: Uint8Array | null = null;
  for (const page of pages) {
    const candidate = await build([...current, page]);
    if (candidate.length <= maxBytes) {
      current.push(page);
      currentBytes = candidate;
      continue;
    }
    if (!current.length) {
      throw new ExtractError(`Page ${page + 1} alone is larger than ${Math.round(maxBytes / 1e6)} MB — export the plans at a lower resolution.`);
    }
    chunks.push(currentBytes!);
    current = [page];
    currentBytes = await build(current);
    if (currentBytes.length > maxBytes) {
      throw new ExtractError(`Page ${page + 1} alone is larger than ${Math.round(maxBytes / 1e6)} MB — export the plans at a lower resolution.`);
    }
  }
  if (currentBytes) chunks.push(currentBytes);
  if (chunks.length > maxChunks) {
    throw new ExtractError(
      `These plans are too large to read at once (${pages.length} pages). Upload just the sheets that matter — roof plan, pool plan, or floor plans and schedules.`,
    );
  }
  return chunks;
}

export function amosExtractor(db: Db, opts: { fetchImpl?: typeof fetch; env?: Record<string, string | undefined> } = {}): Extractor {
  const f = opts.fetchImpl ?? fetch;
  const env = opts.env ?? process.env;
  return async ({ orgId, document, contentType, filename, instructions, schema }) => {
    const app = appId(env);
    if (!app) throw new ExtractError("Roofline isn't linked to AMOS yet (no app id), so it can't read plans.");
    const amosOrg = (await db.get<{ a: string | null }>("SELECT amos_tenant_id AS a FROM orgs WHERE id = ?", orgId))?.a;
    if (!amosOrg) throw new ExtractError("This company isn't linked to AMOS, so plans can't be read automatically.");
    let parts: Uint8Array[];
    if (contentType === "application/pdf") {
      parts = await splitPdf(document);
    } else {
      if (document.length > MAX_IMAGE_BYTES) throw new ExtractError("Images must be 3.75 MB or smaller — export the sheet as a PDF instead.");
      parts = [document];
    }
    const stem = filename.replace(/\.[^.]+$/, "");
    const body = Buffer.from(
      JSON.stringify({
        org_id: amosOrg,
        purpose: "blueprint_takeoff",
        documents: parts.map((bytes, i) => ({
          filename: parts.length > 1 ? `${stem} part ${i + 1}` : stem,
          content_type: contentType,
          data: Buffer.from(bytes).toString("base64"),
        })),
        instructions,
        output_schema: schema,
      }),
    );
    const token = signServiceToken(await serviceKey(db), app, body);
    let res: Response;
    try {
      res = await f(extractUrl(env), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body,
        signal: AbortSignal.timeout(300_000),
      });
    } catch (err) {
      throw new ExtractError(`Couldn't reach AMOS to read the plans (${err instanceof Error ? err.message : String(err)}). Try again.`);
    }
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(text);
    } catch {
      /* non-JSON error page */
    }
    if (!res.ok) {
      throw new ExtractError(`AMOS couldn't read the plans: ${String(json.error ?? `${res.status} ${text.slice(0, 160)}`)}`);
    }
    return json.result;
  };
}
