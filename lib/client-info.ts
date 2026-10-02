// Caller IP + user agent for the signing audit trail. The app sits behind
// the platform load balancer, which sets X-Forwarded-For.
import { headers } from "next/headers";
import type { Client } from "./esign";

export async function clientInfo(): Promise<Client> {
  const h = await headers();
  return {
    ip: h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || "unknown",
    userAgent: h.get("user-agent") ?? "",
  };
}
