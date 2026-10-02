// Durable delivery of Roofline → AMOS messages (domain events and email
// requests). `enqueue` writes a row — inside the caller's transaction when
// one is passed — and `drain` delivers due rows through a Transport with
// exponential backoff. A retry carries the same idempotency key, so AMOS
// accepts each message at most once however many times it's attempted.
//
// No Next imports: the worker loop (lib/amos-worker.ts) and tests drive it.
import type { Db } from "./db.ts";

export type OutboxKind = "event" | "email";

export interface OutboxRow {
  id: number;
  org_id: string;
  kind: OutboxKind;
  topic: string;
  idempotency_key: string;
  payload: string;
  status: string;
  attempts: number;
  next_attempt_at: string;
  last_error: string | null;
  response: string | null;
  created_at: string;
  delivered_at: string | null;
}

/** What delivering one message produced. `retry: false` means the request
 *  itself is bad (4xx other than 408/429) — retrying can't help. */
export type DeliveryResult =
  | { ok: true; response: unknown }
  | { ok: false; retry: boolean; error: string };

export interface Transport {
  deliver(row: OutboxRow): Promise<DeliveryResult>;
}

export const MAX_ATTEMPTS = 12;
/** Claims older than this are presumed abandoned (process died mid-send). */
const STALE_CLAIM_MS = 5 * 60_000;

export function backoffMs(attempts: number): number {
  // 30s, 1m, 2m, 4m … capped at 6h; ~2.5 days of retries before dead.
  return Math.min(30_000 * 2 ** Math.max(0, attempts - 1), 6 * 3_600_000);
}

const sqlTime = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

export async function enqueue(
  db: Db,
  orgId: string,
  kind: OutboxKind,
  topic: string,
  idempotencyKey: string,
  payload: unknown,
): Promise<number | null> {
  // ON CONFLICT DO NOTHING: enqueueing the same logical message twice (a
  // double-clicked button, a replayed action) is a no-op, not an error.
  const r = await db.run(
    `INSERT INTO amos_outbox (org_id, kind, topic, idempotency_key, payload)
     VALUES (?,?,?,?,?) ON CONFLICT (idempotency_key) DO NOTHING`,
    orgId, kind, topic, idempotencyKey.slice(0, 200), JSON.stringify(payload),
  );
  return r.changes ? r.lastId : null;
}

/** Deliver up to `limit` due messages. Returns counts for logging/tests. */
export async function drain(
  db: Db,
  transport: Transport,
  opts: { limit?: number; now?: number } = {},
): Promise<{ delivered: number; retried: number; dead: number }> {
  const now = opts.now ?? Date.now();
  const nowText = sqlTime(now);
  const stats = { delivered: 0, retried: 0, dead: 0 };
  const due = await db.all<OutboxRow>(
    `SELECT * FROM amos_outbox
     WHERE (status = 'pending' AND next_attempt_at <= ?)
        OR (status = 'sending' AND claimed_at < ?)
     ORDER BY id LIMIT ?`,
    nowText, sqlTime(now - STALE_CLAIM_MS), opts.limit ?? 25,
  );
  for (const row of due) {
    // Claim with a conditional update: if another worker got there first,
    // `changes` is 0 and we skip — works the same on Postgres and sqlite.
    const claimed = await db.run(
      `UPDATE amos_outbox SET status = 'sending', claimed_at = ?, attempts = attempts + 1
       WHERE id = ? AND status = ? AND attempts = ?`,
      nowText, row.id, row.status, row.attempts,
    );
    if (!claimed.changes) continue;
    const attempts = Number(row.attempts) + 1;
    let result: DeliveryResult;
    try {
      result = await transport.deliver({ ...row, attempts });
    } catch (err) {
      result = { ok: false, retry: true, error: err instanceof Error ? err.message : String(err) };
    }
    if (result.ok) {
      // A delivered email's payload held the recipient and, for signing
      // requests, a live signing link — keep only the topic once AMOS has it.
      await db.run(
        `UPDATE amos_outbox SET status = 'delivered', delivered_at = ?, response = ?, last_error = NULL${
          row.kind === "email" ? `, payload = '{"redacted":true}'` : ""
        } WHERE id = ?`,
        sqlTime(Date.now()), JSON.stringify(result.response ?? null).slice(0, 4000), row.id,
      );
      stats.delivered++;
    } else if (!result.retry || attempts >= MAX_ATTEMPTS) {
      await db.run(
        "UPDATE amos_outbox SET status = 'dead', last_error = ? WHERE id = ?",
        result.error.slice(0, 2000), row.id,
      );
      stats.dead++;
    } else {
      await db.run(
        "UPDATE amos_outbox SET status = 'pending', next_attempt_at = ?, last_error = ? WHERE id = ?",
        sqlTime(now + backoffMs(attempts)), result.error.slice(0, 2000), row.id,
      );
      stats.retried++;
    }
  }
  return stats;
}

/** Put a dead message back in the queue (admin "retry" button). */
export async function requeue(db: Db, orgId: string, id: number): Promise<boolean> {
  const r = await db.run(
    "UPDATE amos_outbox SET status = 'pending', attempts = 0, next_attempt_at = datetime('now') WHERE id = ? AND org_id = ? AND status = 'dead'",
    id, orgId,
  );
  return r.changes > 0;
}
