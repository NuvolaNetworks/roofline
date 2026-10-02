import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteDb } from "../lib/db-sqlite.ts";
import { DEMO_ORG_ID } from "../lib/demo-fixtures.ts";
import { backoffMs, drain, enqueue, MAX_ATTEMPTS, requeue, type DeliveryResult, type OutboxRow } from "../lib/amos-outbox.ts";

process.env.ROOFLINE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "roofline-outbox-")), "t.db");
const db = createSqliteDb();
const org = DEMO_ORG_ID;

const transport = (fn: (r: OutboxRow) => DeliveryResult) => {
  const seen: OutboxRow[] = [];
  return { seen, deliver: async (r: OutboxRow) => (seen.push(r), fn(r)) };
};
const row = (key: string) => db.get<OutboxRow>("SELECT * FROM amos_outbox WHERE idempotency_key = ?", key);

test("enqueue is idempotent per key", async () => {
  assert.ok(await enqueue(db, org, "event", "proposal.sent", "k-dup", { a: 1 }));
  assert.equal(await enqueue(db, org, "event", "proposal.sent", "k-dup", { a: 2 }), null);
  assert.equal(JSON.parse((await row("k-dup"))!.payload).a, 1);
});

test("delivers due rows once", async () => {
  await enqueue(db, org, "event", "proposal.signed", "k-ok", { p: 1 });
  const t = transport(() => ({ ok: true, response: { id: "r1" } }));
  await drain(db, t);
  assert.equal((await row("k-ok"))!.status, "delivered");
  const again = transport(() => ({ ok: true, response: null }));
  await drain(db, again);
  assert.equal(again.seen.some((r) => r.idempotency_key === "k-ok"), false);
});

test("transient failure backs off and keeps the key; permanent failure goes dead", async () => {
  await enqueue(db, org, "email", "email.x", "k-retry", {});
  const now = Date.now() + 1000;
  await drain(db, transport((r) => (r.idempotency_key === "k-retry" ? { ok: false, retry: true, error: "503" } : { ok: true, response: null })), { now });
  const r = (await row("k-retry"))!;
  assert.equal(r.status, "pending");
  assert.equal(Number(r.attempts), 1);
  assert.equal(r.next_attempt_at, new Date(now + backoffMs(1)).toISOString().slice(0, 19).replace("T", " "));
  // not due yet
  const early = transport(() => ({ ok: true, response: null }));
  await drain(db, early, { now: now + 1000 });
  assert.equal(early.seen.some((x) => x.idempotency_key === "k-retry"), false);

  await enqueue(db, org, "email", "email.x", "k-bad", {});
  await drain(db, transport((x) => (x.idempotency_key === "k-bad" ? { ok: false, retry: false, error: "400 bad recipient" } : { ok: false, retry: true, error: "503" })), { now: now + backoffMs(1) + 1 });
  assert.equal((await row("k-bad"))!.status, "dead");
  assert.ok(await requeue(db, org, Number((await row("k-bad"))!.id)));
  assert.equal((await row("k-bad"))!.status, "pending");
});

test("gives up after MAX_ATTEMPTS", async () => {
  await enqueue(db, org, "event", "x", "k-max", {});
  let now = Date.now() + 1000;
  const fail = transport(() => ({ ok: false, retry: true, error: "timeout" }));
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    await drain(db, fail, { now });
    now += backoffMs(MAX_ATTEMPTS) + 1;
  }
  const r = (await row("k-max"))!;
  assert.equal(r.status, "dead");
  assert.equal(Number(r.attempts), MAX_ATTEMPTS);
});

test("a thrown transport error is retried, not lost", async () => {
  await enqueue(db, org, "event", "x", "k-throw", {});
  await drain(db, { deliver: async () => { throw new Error("ECONNRESET"); } }, { now: Date.now() + 1000 });
  const r = (await row("k-throw"))!;
  assert.equal(r.status, "pending");
  assert.match(r.last_error ?? "", /ECONNRESET/);
});
