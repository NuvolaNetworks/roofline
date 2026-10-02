// Roofline's side of the AMOS app channel (platform: src/mcp/app_sync.rs).
//
// Roofline holds its own Ed25519 key — generated on first use, private half
// encrypted at rest under ROOFLINE_SESSION_SECRET — and publishes the public
// half at /.well-known/amos-app-service-key.json. The builder pins it once
// with AMOS's `app_service_key_register`; no shared secret ever exists.
// Every request to AMOS is an EdDSA JWT (iss = this app's id, aud =
// amos-app-services, bh = SHA-256 of the body) good for 60 seconds.
//
// `amosTransport()` is the outbox Transport (lib/amos-outbox.ts). Node's
// crypto signs Ed25519 natively — no dependency.
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  type KeyObject,
} from "node:crypto";
import type { Db } from "./db.ts";
import type { DeliveryResult, OutboxRow, Transport } from "./amos-outbox.ts";

export const AUDIENCE = "amos-app-services";
const TOKEN_TTL_S = 60;

export function appId(env: Record<string, string | undefined> = process.env): string {
  return env.AMOS_APP_AUTH_APP_ID || "";
}

export function servicesUrl(env: Record<string, string | undefined> = process.env): string {
  if (env.AMOS_APP_SERVICES_URL) return env.AMOS_APP_SERVICES_URL;
  const jwks = env.AMOS_APP_AUTH_JWKS_URL || "https://app.amoslabs.com/.well-known/amos-app-auth/jwks.json";
  return `${new URL(jwks).origin}/api/v1/app-services/messages`;
}

function wrapKey(): Buffer {
  const secret = process.env.ROOFLINE_SESSION_SECRET || "roofline-dev-only";
  return createHash("sha256").update(`roofline-app-service-key:${secret}`).digest();
}

function encrypt(plain: Buffer): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", wrapKey(), iv);
  const body = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString("base64url");
}

function decrypt(enc: string): Buffer {
  const raw = Buffer.from(enc, "base64url");
  const d = createDecipheriv("aes-256-gcm", wrapKey(), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]);
}

export interface ServiceKey {
  kid: string;
  publicKey: string; // base64url raw 32 bytes
  privateKey: KeyObject;
}

let cached: ServiceKey | null = null;

/** The app's service key, created on first call (race-safe: the first
 *  INSERT wins, everyone reads the winner). */
export async function serviceKey(db: Db): Promise<ServiceKey> {
  if (cached) return cached;
  let row = await db.get<{ kid: string; public_key: string; private_key_enc: string }>(
    "SELECT kid, public_key, private_key_enc FROM app_service_key WHERE id = 1",
  );
  if (!row) {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const raw = Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url");
    const kid = `roofline-${createHash("sha256").update(raw).digest("hex").slice(0, 12)}`;
    await db.run(
      "INSERT INTO app_service_key (id, kid, public_key, private_key_enc) VALUES (1, ?, ?, ?) ON CONFLICT (id) DO NOTHING",
      kid, raw.toString("base64url"), encrypt(privateKey.export({ format: "der", type: "pkcs8" }) as Buffer),
    );
    row = await db.get("SELECT kid, public_key, private_key_enc FROM app_service_key WHERE id = 1");
  }
  cached = {
    kid: row!.kid,
    publicKey: row!.public_key,
    privateKey: createPrivateKey({ key: decrypt(row!.private_key_enc), format: "der", type: "pkcs8" }),
  };
  return cached;
}

/** For tests: forget the in-process key cache. */
export function resetServiceKeyCache(): void {
  cached = null;
}

export function keyDocument(k: ServiceKey): { kid: string; alg: "EdDSA"; public_key: string } {
  return { kid: k.kid, alg: "EdDSA", public_key: k.publicKey };
}

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");

export function signServiceToken(k: ServiceKey, app: string, body: Buffer | string, now = Math.floor(Date.now() / 1000)): string {
  const header = b64({ alg: "EdDSA", typ: "JWT", kid: k.kid });
  const claims = b64({
    iss: app,
    aud: AUDIENCE,
    iat: now,
    exp: now + TOKEN_TTL_S,
    bh: createHash("sha256").update(body).digest("base64url"),
  });
  const input = `${header}.${claims}`;
  return `${input}.${sign(null, Buffer.from(input), k.privateKey).toString("base64url")}`;
}

/** Verify a token we signed — used by tests and the settings self-check. */
export function publicKeyObject(k: Pick<ServiceKey, "publicKey">): KeyObject {
  return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: k.publicKey }, format: "jwk" });
}

/** The outbox transport: one signed POST per message. */
export function amosTransport(db: Db, opts: { fetchImpl?: typeof fetch; env?: Record<string, string | undefined> } = {}): Transport {
  const f = opts.fetchImpl ?? fetch;
  const env = opts.env ?? process.env;
  return {
    async deliver(row: OutboxRow): Promise<DeliveryResult> {
      const app = appId(env);
      if (!app) return { ok: false, retry: true, error: "AMOS_APP_AUTH_APP_ID is not set" };
      const body = Buffer.from(row.payload);
      const token = signServiceToken(await serviceKey(db), app, body);
      let res: Response;
      try {
        res = await f(servicesUrl(env), {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body,
          signal: AbortSignal.timeout(15_000),
        });
      } catch (err) {
        return { ok: false, retry: true, error: `network: ${err instanceof Error ? err.message : String(err)}` };
      }
      const text = await res.text();
      let json: Record<string, unknown> = {};
      try {
        json = JSON.parse(text);
      } catch {
        /* non-JSON error page */
      }
      if (res.ok) return { ok: true, response: json };
      const retryable =
        typeof json.retryable === "boolean" ? json.retryable : res.status >= 500 || res.status === 408 || res.status === 429;
      // 401 before the key is registered, and 404 before the platform ships
      // the endpoint, are the normal states of a fresh install — keep
      // retrying (with backoff, ~2.5 days) until both are in place.
      const retry = retryable || res.status === 401 || res.status === 404;
      return { ok: false, retry, error: `${res.status} ${String(json.code ?? "")} ${String(json.error ?? text.slice(0, 200))}`.trim() };
    },
  };
}
