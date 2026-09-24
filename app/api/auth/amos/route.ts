import { NextResponse } from "next/server";
import { verifyAmosIdentity } from "@/lib/amos-identity";
import { loginWithAmosIdentity } from "@/lib/auth";

/**
 * POST { token } — the identity JWT the AMOS platform put in the redirect
 * fragment after sign-in. Verified against the platform JWKS (EdDSA, aud =
 * this app, exp), then exchanged for Roofline's own session cookie. Any
 * failure is a plain 401; the token never leaves the request.
 */
export async function POST(req: Request) {
  let token: string | null = null;
  try {
    const body = (await req.json()) as { token?: unknown };
    token = typeof body.token === "string" ? body.token : null;
  } catch {
    token = null;
  }
  const identity = await verifyAmosIdentity(token);
  if (!identity) {
    return NextResponse.json({ ok: false, error: "identity token not accepted" }, { status: 401 });
  }
  const user = await loginWithAmosIdentity(identity);
  if (!user) {
    return NextResponse.json({ ok: false, error: "no Roofline user for this identity" }, { status: 403 });
  }
  return NextResponse.json({ ok: true, user: { id: user.id, email: user.email, role: user.role } });
}
