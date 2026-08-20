/**
 * C1 — the session HMAC secret must never fall back to the public built-in
 * default outside pure demo, or sessions become forgeable (user ids are
 * sequential, so an attacker would become admin of every org).
 * L1 — the signed session payload carries an expiry and org id, and a stale
 * or tampered cookie is rejected.
 *
 * lib/session.ts is deliberately free of next/* imports so it loads here.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveSessionSecret,
  makeSessionCookie,
  readSession,
  COMPROMISED_DEFAULT_SECRET,
  SESSION_TTL_S,
} from "../lib/session.ts";

test("C1: session secret fails closed outside pure demo", async (t) => {
  const strong = "a-genuinely-random-32-byte-secret-value";

  await t.test("production without a secret throws", () => {
    assert.throws(() => resolveSessionSecret({ NODE_ENV: "production" }));
  });

  await t.test("amos auth mode without a secret throws", () => {
    assert.throws(() => resolveSessionSecret({ AUTH_MODE: "amos" }));
  });

  await t.test("any DATABASE_URL without a secret throws", () => {
    assert.throws(() =>
      resolveSessionSecret({ DATABASE_URL: "postgres://db/roofline" }),
    );
  });

  await t.test("the compromised default is rejected specifically", () => {
    assert.throws(() =>
      resolveSessionSecret({
        NODE_ENV: "production",
        ROOFLINE_SESSION_SECRET: COMPROMISED_DEFAULT_SECRET,
      }),
    );
    // even in amos mode / with a db, the old string is refused
    assert.throws(() =>
      resolveSessionSecret({
        DATABASE_URL: "postgres://db/roofline",
        ROOFLINE_SESSION_SECRET: COMPROMISED_DEFAULT_SECRET,
      }),
    );
  });

  await t.test("a strong secret is accepted in hardened contexts", () => {
    assert.equal(
      resolveSessionSecret({ NODE_ENV: "production", ROOFLINE_SESSION_SECRET: strong }),
      strong,
    );
    assert.equal(
      resolveSessionSecret({ AUTH_MODE: "amos", ROOFLINE_SESSION_SECRET: strong }),
      strong,
    );
  });

  await t.test("pure demo may fall back, or use a custom secret", () => {
    assert.equal(resolveSessionSecret({}), COMPROMISED_DEFAULT_SECRET);
    assert.equal(resolveSessionSecret({ AUTH_MODE: "demo" }), COMPROMISED_DEFAULT_SECRET);
    assert.equal(
      resolveSessionSecret({ ROOFLINE_SESSION_SECRET: "custom-demo" }),
      "custom-demo",
    );
  });

  await t.test("module load throws when the env is hardened + unsafe", async () => {
    const saved = { ...process.env };
    delete process.env.ROOFLINE_SESSION_SECRET;
    process.env.DATABASE_URL = "postgres://db/roofline";
    // Non-literal specifier + cache-buster so the module re-evaluates its
    // module-load secret check under the hardened env we just set.
    const spec = "../lib/session.ts?hardened-boot";
    try {
      await assert.rejects(() => import(spec));
    } finally {
      // restore env for any later work in this process
      for (const k of Object.keys(process.env)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });
});

test("L1: signed payload round-trips, expires, and resists tampering", async (t) => {
  const now = 1_700_000_000_000; // fixed ms
  const nowS = Math.floor(now / 1000);
  const payload = { uid: 42, org: "org-abc", exp: nowS + SESSION_TTL_S };

  await t.test("valid cookie decodes to the same payload", () => {
    const cookie = makeSessionCookie(payload);
    assert.deepEqual(readSession(cookie, now), payload);
  });

  await t.test("expired payload is rejected", () => {
    const cookie = makeSessionCookie({ ...payload, exp: nowS - 1 });
    assert.equal(readSession(cookie, now), null);
  });

  await t.test("tampered signature is rejected", () => {
    const cookie = makeSessionCookie(payload);
    const [body] = cookie.split(".");
    assert.equal(readSession(`${body}.deadbeef`, now), null);
  });

  await t.test("tampered payload (re-encoded exp) breaks the signature", () => {
    const cookie = makeSessionCookie(payload);
    const mac = cookie.slice(cookie.lastIndexOf(".") + 1);
    const forged = Buffer.from(
      JSON.stringify({ ...payload, exp: nowS + 10 * SESSION_TTL_S }),
    ).toString("base64url");
    assert.equal(readSession(`${forged}.${mac}`, now), null);
  });

  await t.test("garbage and empty cookies are rejected", () => {
    assert.equal(readSession(undefined, now), null);
    assert.equal(readSession("", now), null);
    assert.equal(readSession("no-dot", now), null);
    assert.equal(readSession("123.abc", now), null);
  });
});
