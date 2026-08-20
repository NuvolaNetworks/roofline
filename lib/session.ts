// Session cryptography, kept free of next/* imports so it can be unit-tested
// outside a Next server (and so the secret check runs at plain module load).
//
// The session is an HMAC-signed cookie carrying a small JSON payload:
//   { uid, org, exp }  — signed as base64url(payload) + "." + hex(hmac).
// currentUser() (lib/auth.ts) verifies the signature, rejects a stale or
// org-mismatched payload, then resolves the users row.
import { createHmac, timingSafeEqual } from "node:crypto";

/** The pre-hardening default. Public (it shipped in git), therefore
 *  compromised: a session signed with it is forgeable, and user ids are
 *  sequential, so it must be rejected outright outside pure demo. */
export const COMPROMISED_DEFAULT_SECRET = "roofline-demo-secret";

/** 12h session lifetime — the value both the cookie maxAge and the signed
 *  `exp` claim use, so a tampered/stale cookie can't outlive it. */
export const SESSION_TTL_S = 60 * 60 * 12;

export interface SessionPayload {
  /** users.id */
  uid: number;
  /** orgs.id the session was minted for — cross-checked against the row. */
  org: string;
  /** absolute expiry, unix seconds. */
  exp: number;
}

/**
 * Resolve the HMAC signing secret, failing closed everywhere that isn't a
 * pure local sqlite demo. "Hardened" = production, amos auth mode, or any
 * DATABASE_URL. In those contexts an unset secret — or the compromised
 * built-in default — is a fatal misconfiguration, because it would let an
 * attacker forge the sequential-id session of any user (admin of every org).
 * Only pure demo (sqlite, no DATABASE_URL, no amos mode) may fall back.
 */
export function resolveSessionSecret(
  env: Record<string, string | undefined> = process.env,
): string {
  const secret = env.ROOFLINE_SESSION_SECRET;
  // `next build` evaluates modules with NODE_ENV=production while collecting
  // page data, but nothing signs a cookie then — the runtime secret neither
  // exists nor is needed yet. Skip the throw during the build phase so it
  // doesn't kill the image build; the guard still fires at server start /
  // request time (NEXT_PHASE is "phase-production-server" or unset then).
  const buildPhase = env.NEXT_PHASE === "phase-production-build";
  const hardened =
    !buildPhase &&
    (env.NODE_ENV === "production" ||
      env.AUTH_MODE === "amos" ||
      Boolean(env.DATABASE_URL));
  if (hardened) {
    if (!secret || secret === COMPROMISED_DEFAULT_SECRET) {
      throw new Error(
        "ROOFLINE_SESSION_SECRET is missing or set to the built-in demo default. " +
          "That default is public and compromised — session cookies signed with " +
          "it are forgeable, letting an attacker impersonate any user. Set " +
          "ROOFLINE_SESSION_SECRET to a strong, unique random value (32+ bytes) " +
          "before running in production, amos auth mode, or against a database.",
      );
    }
    return secret;
  }
  // Pure demo: allow the fallback so local sqlite dev needs no setup.
  return secret || COMPROMISED_DEFAULT_SECRET;
}

// Resolved once at module load — so a misconfigured deploy fails fast at boot
// rather than silently signing forgeable cookies.
const SECRET = resolveSessionSecret();

function sign(value: string): string {
  return createHmac("sha256", SECRET).update(value).digest("hex");
}

function encodePayload(p: SessionPayload): string {
  return Buffer.from(JSON.stringify(p)).toString("base64url");
}

function decodePayload(encoded: string): SessionPayload | null {
  try {
    const p = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (
      p &&
      typeof p.uid === "number" &&
      typeof p.org === "string" &&
      typeof p.exp === "number"
    ) {
      return p as SessionPayload;
    }
    return null;
  } catch {
    return null;
  }
}

/** Build the signed cookie value for a session payload. */
export function makeSessionCookie(p: SessionPayload): string {
  const encoded = encodePayload(p);
  return `${encoded}.${sign(encoded)}`;
}

/**
 * Verify a raw cookie value and return its payload, or null for any failure:
 * bad shape, bad signature, or an expired payload. Time is injectable for
 * tests. Does not touch the database — the caller loads the user and confirms
 * the org still matches.
 */
export function readSession(
  raw: string | undefined,
  now: number = Date.now(),
): SessionPayload | null {
  if (!raw) return null;
  const dot = raw.lastIndexOf(".");
  if (dot < 1) return null;
  const encoded = raw.slice(0, dot);
  const mac = raw.slice(dot + 1);
  const expect = sign(encoded);
  if (
    mac.length !== expect.length ||
    !timingSafeEqual(Buffer.from(mac), Buffer.from(expect))
  ) {
    return null;
  }
  const payload = decodePayload(encoded);
  if (!payload) return null;
  if (payload.exp <= Math.floor(now / 1000)) return null;
  return payload;
}
