import { redirect } from "next/navigation";
import { pickIdentityToken, verifyAmosIdentity } from "@/lib/amos-identity";
import { provisionFromIdentity } from "@/lib/amos-auth";
import { authMode, establishSession } from "@/lib/auth";

/**
 * Platform-IdP login callback (AUTH_MODE=amos). The AMOS IdP owns signup and
 * login; it lands the user here with the short-lived EdDSA identity JWT —
 * preferably as the `X-Amos-Identity` header when the platform proxies the
 * redirect, or as ?token= on a direct redirect. We verify it against the
 * published JWKS (lib/amos-identity.ts — no shared secret, no auth code),
 * auto-provision the org/user on first login, and set the same HMAC session
 * cookie demo mode uses. Everything downstream of currentUser() is identical.
 *
 * M3: a token in ?token= leaks into logs/history/Referer, so we prefer the
 * header and, whenever a query token is involved (success OR failure), we only
 * ever redirect to a token-less URL — the address bar and Referer for anything
 * loaded next never carry the JWT.
 */
export async function GET(req: Request) {
  if (authMode() !== "amos") redirect("/login?error=mode");
  const { token } = pickIdentityToken(
    req.headers.get("x-amos-identity"),
    new URL(req.url).searchParams.get("token"),
  );
  const identity = await verifyAmosIdentity(token);
  if (!identity) redirect("/login?error=amos"); // clean, never echoes the token
  const { userId } = await provisionFromIdentity(identity);
  await establishSession(userId);
  redirect("/"); // clean landing — strips any ?token= from the callback URL
}
