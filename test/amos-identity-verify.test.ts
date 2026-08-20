/**
 * M2 — the identity JWT's `iss` claim must be verified. A valid EdDSA
 * signature from the right keys is not sufficient if the token was minted for
 * a different issuer/environment. Also re-covers the existing aud/exp checks.
 *
 * Self-signs an Ed25519 token and serves the matching JWKS via a mocked fetch,
 * so it needs no network. Env is set before importing the module under test,
 * since it reads APP_ID / JWKS_URL / issuer at load.
 */
import test from "node:test";
import assert from "node:assert/strict";

const APP_ID = "roofline-app";
process.env.AMOS_APP_AUTH_APP_ID = APP_ID;
process.env.AMOS_APP_AUTH_JWKS_URL = "https://idp.example/jwks.json";
delete process.env.AMOS_APP_AUTH_ISS; // derive issuer from the JWKS origin
const EXPECTED_ISS = "https://idp.example";

const KID = "k-test-1";

const { publicKey, privateKey } = (await crypto.subtle.generateKey(
  { name: "Ed25519" },
  true,
  ["sign", "verify"],
)) as CryptoKeyPair;

const jwk = { ...(await crypto.subtle.exportKey("jwk", publicKey)), kid: KID };

// Serve the JWKS from a mocked fetch (the module fetches JWKS_URL).
globalThis.fetch = (async () =>
  new Response(JSON.stringify({ keys: [jwk] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })) as typeof fetch;

const { verifyAmosIdentity } = await import("../lib/amos-identity.ts");

const b64url = (s: string) => Buffer.from(s).toString("base64url");

async function signToken(claims: Record<string, unknown>): Promise<string> {
  const header = b64url(JSON.stringify({ alg: "EdDSA", kid: KID }));
  const payload = b64url(JSON.stringify(claims));
  const data = new TextEncoder().encode(`${header}.${payload}`);
  const sig = await crypto.subtle.sign({ name: "Ed25519" }, privateKey, data);
  const sigB64 = Buffer.from(new Uint8Array(sig)).toString("base64url");
  return `${header}.${payload}.${sigB64}`;
}

const baseClaims = () => ({
  sub: "user_1",
  org_id: "11111111-1111-4111-8111-111111111111",
  email: "owner@x.test",
  role: "owner",
  plan_key: "pro",
  entitlements: [],
  subscription_status: "active",
  app_id: APP_ID,
  aud: APP_ID,
  iss: EXPECTED_ISS,
  exp: Math.floor(Date.now() / 1000) + 300,
});

test("M2: verifyAmosIdentity checks signature, aud, exp AND iss", async (t) => {
  await t.test("a well-formed token verifies", async () => {
    const claims = await verifyAmosIdentity(await signToken(baseClaims()));
    assert.ok(claims);
    assert.equal(claims!.org_id, baseClaims().org_id);
  });

  await t.test("a wrong issuer is rejected even with a valid signature", async () => {
    const token = await signToken({ ...baseClaims(), iss: "https://evil.example" });
    assert.equal(await verifyAmosIdentity(token), null);
  });

  await t.test("a missing issuer is rejected", async () => {
    const c = baseClaims() as Record<string, unknown>;
    delete c.iss;
    assert.equal(await verifyAmosIdentity(await signToken(c)), null);
  });

  await t.test("a wrong audience is rejected", async () => {
    const token = await signToken({ ...baseClaims(), aud: "some-other-app" });
    assert.equal(await verifyAmosIdentity(token), null);
  });

  await t.test("an expired token is rejected", async () => {
    const token = await signToken({ ...baseClaims(), exp: Math.floor(Date.now() / 1000) - 1 });
    assert.equal(await verifyAmosIdentity(token), null);
  });

  await t.test("a tampered payload breaks the signature", async () => {
    const token = await signToken(baseClaims());
    const [h, , s] = token.split(".");
    const forged = b64url(JSON.stringify({ ...baseClaims(), role: "admin", sub: "attacker" }));
    assert.equal(await verifyAmosIdentity(`${h}.${forged}.${s}`), null);
  });
});
