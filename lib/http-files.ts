// Response helpers for serving stored files and rendered PDFs. Always
// no-store (signing state changes; links are credentials) and nosniff
// (the type was sniffed on upload; don't let the browser re-guess).
import type { StoredFile } from "./files.ts";

const asciiName = (name: string) => name.replace(/[^\x20-\x7e]+/g, "_").replace(/["\\]/g, "_");

function headersFor(contentType: string, filename: string, download: boolean): HeadersInit {
  return {
    "Content-Type": contentType,
    "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${asciiName(filename)}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  };
}

export function pdfResponse(pdf: Uint8Array, filename: string, download = false): Response {
  return new Response(pdf as BodyInit, { headers: headersFor("application/pdf", filename, download) });
}

export function fileResponse(f: StoredFile, download = false): Response {
  return new Response(f.bytes as BodyInit, { headers: headersFor(f.content_type, f.filename, download) });
}

export function dataUrl(f: Pick<StoredFile, "bytes" | "content_type">): string {
  return `data:${f.content_type};base64,${Buffer.from(f.bytes).toString("base64")}`;
}
