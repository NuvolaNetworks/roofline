// Stored files (logos, spec sheets, signature images, signed PDFs), kept in
// the database as bytea/BLOB — see migrations/003. Every read is org-scoped.
// Content type is decided by sniffing the bytes, never by what the browser
// claimed, and only the formats the renderers understand are accepted.
import { createHash } from "node:crypto";
import type { Db } from "./db.ts";

export const MAX_FILE_BYTES = 15 * 1024 * 1024;

export type FilePurpose = "logo" | "attachment" | "signature" | "signed_pdf";

export interface StoredFile {
  id: number;
  filename: string;
  content_type: string;
  sha256: string;
  size_bytes: number;
  bytes: Uint8Array;
}

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** PDF, PNG or JPEG by magic number; null for anything else. */
export function sniffContentType(bytes: Uint8Array): string | null {
  const b = bytes;
  if (b.length >= 5 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2d) {
    return "application/pdf";
  }
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) {
    return "image/png";
  }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  return null;
}

export function cleanFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  return base.replace(/[^\w.\- ()&]+/g, "_").slice(0, 120) || "file";
}

export class FileRejected extends Error {}

export async function putFile(
  db: Db,
  orgId: string,
  purpose: FilePurpose,
  filename: string,
  bytes: Uint8Array,
  allowed: ReadonlyArray<string> = ["application/pdf", "image/png", "image/jpeg"],
): Promise<{ id: number; sha256: string; content_type: string }> {
  if (bytes.length === 0) throw new FileRejected("The file is empty.");
  if (bytes.length > MAX_FILE_BYTES) throw new FileRejected("Files must be 15 MB or smaller.");
  const contentType = sniffContentType(bytes);
  if (!contentType || !allowed.includes(contentType)) {
    throw new FileRejected(`Unsupported file type — use ${allowed.map((t) => t.split("/")[1].toUpperCase()).join(" or ")}.`);
  }
  const sha256 = sha256Hex(bytes);
  const res = await db.run(
    "INSERT INTO files (org_id, purpose, filename, content_type, size_bytes, sha256, bytes) VALUES (?,?,?,?,?,?,?)",
    orgId, purpose, cleanFilename(filename), contentType, bytes.length, sha256, bytes,
  );
  return { id: res.lastId, sha256, content_type: contentType };
}

export async function getFile(db: Db, orgId: string, id: number): Promise<StoredFile | null> {
  if (!Number.isInteger(id) || id <= 0) return null;
  const row = await db.get<StoredFile>(
    "SELECT id, filename, content_type, sha256, size_bytes, bytes FROM files WHERE id = ? AND org_id = ?",
    id, orgId,
  );
  if (!row) return null;
  return { ...row, id: Number(row.id), size_bytes: Number(row.size_bytes), bytes: new Uint8Array(row.bytes) };
}

export interface FileMeta {
  file_id: number;
  filename: string;
  sha256: string;
  content_type: string;
  purpose: string;
}

export async function fileMeta(db: Db, orgId: string, ids: number[]): Promise<Map<number, FileMeta>> {
  const out = new Map<number, FileMeta>();
  const unique = [...new Set(ids.filter((i) => Number.isInteger(i) && i > 0))];
  if (!unique.length) return out;
  const rows = await db.all<{ id: number; filename: string; sha256: string; content_type: string; purpose: string }>(
    `SELECT id, filename, sha256, content_type, purpose FROM files WHERE org_id = ? AND id IN (${unique.map(() => "?").join(",")})`,
    orgId, ...unique,
  );
  for (const r of rows) {
    out.set(Number(r.id), { file_id: Number(r.id), filename: r.filename, sha256: r.sha256, content_type: r.content_type, purpose: r.purpose });
  }
  return out;
}

/** Read a FormData file field into bytes (null when nothing was chosen). */
export async function formFile(formData: FormData, field: string): Promise<{ name: string; bytes: Uint8Array } | null> {
  const f = formData.get(field);
  if (!f || typeof f === "string" || f.size === 0) return null;
  return { name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) };
}
