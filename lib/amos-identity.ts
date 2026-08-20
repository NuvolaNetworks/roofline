/**
 * AMOS app-identity verification (Build & Sell B2).
 *
 * The platform IdP mints a short-lived EdDSA (Ed25519) JWT for an end user and
 * proxies it to this app as `X-Amos-Identity` — including on every MCP tool
 * call AMOS makes on a customer's behalf. We verify it against the public
 * JWKS; there is no shared secret and no auth code in this app.
 *
 * Contract (from the platform's own docs, verbatim):
 *   - verify the signature via the JWKS URL, algorithm EdDSA;
 *   - check `aud` == this app's id and `exp`;
 *   - `org_id` is THE tenancy key — scope every query by it, and never accept
 *     an org id from a request body when the token supplies one.
 *
 * Node's webcrypto verifies Ed25519 natively, so this needs no dependency —
 * which matters under our ignore-scripts npm hardening.
 */

const JWKS_URL =
  process.env.AMOS_APP_AUTH_JWKS_URL ||
  "https://app.amoslabs.com/.well-known/amos-app-auth/jwks.json";
const APP_ID = process.env.AMOS_APP_AUTH_APP_ID || "";
// Expected token issuer. Prefer an explicit config; otherwise derive it from
// the JWKS origin (the IdP signs and publishes keys at the same origin). Since
// JWKS_URL always has a value, this is never empty — an unset issuer would be
// a misconfiguration, and the strict compare below fails closed regardless.
const EXPECTED_ISS =
  process.env.AMOS_APP_AUTH_ISS || new URL(JWKS_URL).origin;
const JWKS_TTL_MS = 5 * 60 * 1000;

export interface AmosIdentity {
  sub: string;
  org_id: string;
  email: string;
  role: string;
  /** Optional display claims — used at org/user provisioning when present. */
  name?: string;
  org_name?: string;
  plan_key: string;
  entitlements: string[];
  subscription_status: string;
  app_id: string;
  aud: string;
  iss: string;
  exp: number;
}

interface Jwk {
  kid: string;
  kty: string;
  crv: string;
  x: string;
  alg?: string;
}

let cache: { at: number; keys: Jwk[] } | null = null;

async function jwks(): Promise<Jwk[]> {
  if (cache && Date.now() - cache.at < JWKS_TTL_MS) return cache.keys;
  const res = await fetch(JWKS_URL, { cache: "no-store" });
  if (!res.ok) throw new Error(`jwks ${res.status}`);
  const body = (await res.json()) as { keys?: Jwk[] };
  const keys = body.keys ?? [];
  cache = { at: Date.now(), keys };
  return keys;
}

function b64urlToBytes(s: string): ArrayBuffer {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const buf = Buffer.from(b64, "base64");
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

/**
 * Verify an `X-Amos-Identity` token. Returns the claims, or null for any
 * failure — a bad token is indistinguishable from no token to the caller, so
 * routes fail closed with 401 either way.
 */
export async function verifyAmosIdentity(
  token: string | null,
): Promise<AmosIdentity | null> {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts;

  let header: { alg?: string; kid?: string };
  let claims: AmosIdentity;
  try {
    header = JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8"));
    claims = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (header.alg !== "EdDSA") return null;

  const keys = await jwks().catch(() => [] as Jwk[]);
  // Prefer the kid the token names; fall back to trying every published key so
  // a rotation mid-flight doesn't reject a valid token.
  const candidates = header.kid
    ? [...keys.filter((k) => k.kid === header.kid), ...keys.filter((k) => k.kid !== header.kid)]
    : keys;
  if (candidates.length === 0) return null;

  const encoded = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const data = encoded.buffer.slice(
    encoded.byteOffset,
    encoded.byteOffset + encoded.byteLength,
  ) as ArrayBuffer;
  const sig = b64urlToBytes(sigB64);
  let ok = false;
  for (const jwk of candidates) {
    if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519") continue;
    try {
      const key = await crypto.subtle.importKey(
        "jwk",
        { kty: jwk.kty, crv: jwk.crv, x: jwk.x },
        { name: "Ed25519" },
        false,
        ["verify"],
      );
      if (await crypto.subtle.verify({ name: "Ed25519" }, key, sig, data)) {
        ok = true;
        break;
      }
    } catch {
      /* try the next key */
    }
  }
  if (!ok) return null;

  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== "number" || claims.exp <= now) return null;
  // aud must be this app. APP_ID unset (not yet injected by the platform) is
  // treated as misconfiguration and fails closed rather than accepting any
  // audience.
  if (!APP_ID || claims.aud !== APP_ID) return null;
  // iss must be the expected issuer — a valid signature from the right keys is
  // not enough if the token was minted for a different issuer/environment.
  if (!claims.iss || claims.iss !== EXPECTED_ISS) return null;
  if (!claims.org_id) return null;
  return claims;
}
