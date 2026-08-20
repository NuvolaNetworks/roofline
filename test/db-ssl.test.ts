/**
 * L2 — production Postgres TLS must verify the server certificate by default
 * (rejectUnauthorized: true), with DATABASE_SSL as the documented escape hatch.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { sslConfig } from "../lib/db-postgres.ts";

test("L2: Postgres TLS verifies the CA in production by default", async (t) => {
  await t.test("production default verifies the certificate", () => {
    assert.deepEqual(sslConfig({ NODE_ENV: "production" }), { rejectUnauthorized: true });
  });

  await t.test("local dev default is plaintext (no TLS)", () => {
    assert.equal(sslConfig({ NODE_ENV: "development" }), false);
    assert.equal(sslConfig({}), false);
  });

  await t.test("verify forces CA verification anywhere", () => {
    assert.deepEqual(sslConfig({ DATABASE_SSL: "verify" }), { rejectUnauthorized: true });
  });

  await t.test("no-verify is the escape hatch — encrypt without verifying", () => {
    assert.deepEqual(
      sslConfig({ NODE_ENV: "production", DATABASE_SSL: "no-verify" }),
      { rejectUnauthorized: false },
    );
  });

  await t.test("disable turns TLS off explicitly", () => {
    assert.equal(sslConfig({ NODE_ENV: "production", DATABASE_SSL: "disable" }), false);
  });
});
