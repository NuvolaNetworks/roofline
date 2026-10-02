// The app's public origin for links in outgoing email: ROOFLINE_PUBLIC_URL
// when set, else the request's forwarded host. AMOS refuses any email link
// that isn't on one of this app's registered hosts, so a spoofed Host header
// can't produce a working phishing link.
import { headers } from "next/headers";

export async function requestOrigin(): Promise<string> {
  if (process.env.ROOFLINE_PUBLIC_URL) return process.env.ROOFLINE_PUBLIC_URL.replace(/\/$/, "");
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}
