/**
 * L2 — production Postgres TLS must verify the server certificate by default
 * (rejectUnauthorized: true) against the bundled RDS CA, with DATABASE_SSL as
 * the documented escape hatch.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sslConfig, loadCaBundle, caBundlePath } from "../lib/db-postgres.ts";

// A throwaway CA file so the verify-path tests don't depend on the real
// 165 KB bundle; a separate case below asserts the shipped bundle loads too.
const FIXTURE = join(tmpdir(), "roofline-test-ca.pem");
writeFileSync(FIXTURE, "-----BEGIN CERTIFICATE-----\nMIIFAKE\n-----END CERTIFICATE-----\n");
const FIXTURE_PEM = "-----BEGIN CERTIFICATE-----\nMIIFAKE\n-----END CERTIFICATE-----\n";

test("L2: Postgres TLS verifies the CA in production by default", async (t) => {
  await t.test("production default verifies against the bundled CA", () => {
    const cfg = sslConfig({ NODE_ENV: "production", DATABASE_CA_BUNDLE: FIXTURE });
    assert.deepEqual(cfg, { rejectUnauthorized: true, ca: FIXTURE_PEM });
  });

  await t.test("verify forces CA verification anywhere", () => {
    const cfg = sslConfig({ DATABASE_SSL: "verify", DATABASE_CA_BUNDLE: FIXTURE });
    assert.deepEqual(cfg, { rejectUnauthorized: true, ca: FIXTURE_PEM });
  });

  await t.test("local dev default is plaintext (no TLS)", () => {
    assert.equal(sslConfig({ NODE_ENV: "development" }), false);
    assert.equal(sslConfig({}), false);
  });

  await t.test("no-verify is the escape hatch — encrypt without verifying, no ca", () => {
    assert.deepEqual(
      sslConfig({ NODE_ENV: "production", DATABASE_SSL: "no-verify" }),
      { rejectUnauthorized: false },
    );
  });

  await t.test("disable turns TLS off explicitly", () => {
    assert.equal(sslConfig({ NODE_ENV: "production", DATABASE_SSL: "disable" }), false);
  });

  await t.test("the shipped RDS bundle exists and is a real cert chain", () => {
    // Default path points at the bundled cert; it must load and contain certs.
    assert.match(caBundlePath({}), /certs[/\\]rds-global-bundle\.pem$/);
    const bundle = loadCaBundle({});
    assert.match(bundle, /-----BEGIN CERTIFICATE-----/);
  });

  await t.test("DATABASE_CA_BUNDLE overrides the bundled path", () => {
    assert.equal(caBundlePath({ DATABASE_CA_BUNDLE: FIXTURE }), FIXTURE);
    assert.equal(loadCaBundle({ DATABASE_CA_BUNDLE: FIXTURE }), FIXTURE_PEM);
  });
});
