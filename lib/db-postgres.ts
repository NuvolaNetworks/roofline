// Production backend: pooled Postgres via `pg`, selected when DATABASE_URL
// is set. Applies migrations/*.sql idempotently before the first query
// (single-flight, guarded by an advisory lock so concurrent instances don't
// race on boot).
//
// The app's SQL stays in the sqlite dialect it started with; this adapter
// translates the exact sqlite-isms in use — nothing speculative:
//   ?                      → $1..$n
//   datetime('now')        → UTC "YYYY-MM-DD HH24:MI:SS" text (timestamps are
//                            stored as TEXT in that format on purpose, so the
//                            whole read surface renders identically on both
//                            backends; see migrations/001_init.sql)
//   datetime('now', '±N days') / date('now'[, '±N days']) → interval math
//   date(col)              → substr(col, 1, 10)
import { Pool, types } from "pg";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Db, RunResult, SqlValue } from "./db.ts";

// pg returns int8/numeric as strings; the app does arithmetic on COUNT/SUM
// results, so parse them to numbers (values here are cents and row counts —
// far below Number.MAX_SAFE_INTEGER).
let parsersInstalled = false;
function installTypeParsers() {
  if (parsersInstalled) return;
  parsersInstalled = true;
  types.setTypeParser(20, (v) => Number(v)); // int8
  types.setTypeParser(1700, (v) => Number(v)); // numeric
}

const NOW_TEXT = `to_char(timezone('utc', now()), 'YYYY-MM-DD HH24:MI:SS')`;

/** Translate the app's sqlite-dialect SQL to Postgres. Exported for tests. */
export function toPostgres(sql: string): string {
  let out = sql;
  out = out.replace(
    /datetime\('now'\s*,\s*\?\)/gi,
    `to_char(timezone('utc', now()) + (?)::interval, 'YYYY-MM-DD HH24:MI:SS')`,
  );
  out = out.replace(
    /datetime\('now'\s*,\s*'([^']*)'\)/gi,
    `to_char(timezone('utc', now()) + interval '$1', 'YYYY-MM-DD HH24:MI:SS')`,
  );
  out = out.replace(/datetime\('now'\)/gi, NOW_TEXT);
  out = out.replace(
    /date\('now'\s*,\s*'([^']*)'\)/gi,
    `to_char((timezone('utc', now()) + interval '$1')::date, 'YYYY-MM-DD')`,
  );
  out = out.replace(/date\('now'\)/gi, `to_char(timezone('utc', now()), 'YYYY-MM-DD')`);
  out = out.replace(/(?<![\w.])date\(([a-z_][\w.]*)\)/gi, "substr($1, 1, 10)");
  let n = 0;
  out = out.replace(/\?/g, () => `$${++n}`);
  return out;
}

/** TLS to Postgres. In production the default now VERIFIES the server
 *  certificate against the trust store (rejectUnauthorized: true), so a
 *  MITM can't present a rogue cert. Escape hatches for environments still
 *  wiring up a CA bundle:
 *    DATABASE_SSL=verify     — force CA verification (also the prod default)
 *    DATABASE_SSL=no-verify  — encrypt but skip verification (documented risk)
 *    DATABASE_SSL=disable    — no TLS (local dev)
 *  Outside production with no override, TLS stays off for local dev. */
export function sslConfig(
  env: Record<string, string | undefined> = process.env,
): false | { rejectUnauthorized: boolean } {
  switch (env.DATABASE_SSL) {
    case "disable":
      return false;
    case "no-verify":
      return { rejectUnauthorized: false };
    case "verify":
      return { rejectUnauthorized: true };
    default:
      return env.NODE_ENV === "production" ? { rejectUnauthorized: true } : false;
  }
}

const MIGRATION_LOCK_KEY = 727761; // arbitrary app-wide advisory lock id

async function migrate(pool: Pool): Promise<void> {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       filename TEXT PRIMARY KEY,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  );
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    const applied = new Set(
      (await client.query("SELECT filename FROM schema_migrations")).rows.map(
        (r: { filename: string }) => r.filename,
      ),
    );
    const dir = join(process.cwd(), "migrations");
    const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(join(dir, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [file]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]).catch(() => {});
    client.release();
  }
}

// A minimal query executor — both `pool.query` and a checked-out client's
// `query` satisfy it, so the query methods work identically on the pool and
// inside a transaction.
type QueryFn = (
  text: string,
  params: SqlValue[],
) => Promise<{ rows: unknown[]; rowCount: number | null }>;

async function runWith(query: QueryFn, sql: string, params: SqlValue[]): Promise<RunResult> {
  const wantsId = /^\s*insert\b/i.test(sql) && !/\breturning\b/i.test(sql);
  const text = wantsId ? `${toPostgres(sql)} RETURNING id` : toPostgres(sql);
  const res = await query(text, params);
  const id = wantsId ? (res.rows[0] as { id?: unknown } | undefined)?.id : undefined;
  return { lastId: typeof id === "number" ? id : 0, changes: res.rowCount ?? 0 };
}

export function createPostgresDb(url: string): Db {
  installTypeParsers();
  const pool = new Pool({
    connectionString: url,
    max: Number(process.env.DATABASE_POOL_MAX || 10),
    ssl: sslConfig() || undefined,
  });
  let ready: Promise<void> | null = null;
  const ensureReady = () => (ready ??= migrate(pool));

  return {
    async all<T = Record<string, unknown>>(sql: string, ...params: SqlValue[]): Promise<T[]> {
      await ensureReady();
      const res = await pool.query(toPostgres(sql), params);
      return res.rows as T[];
    },
    async get<T = Record<string, unknown>>(sql: string, ...params: SqlValue[]): Promise<T | undefined> {
      await ensureReady();
      const res = await pool.query(toPostgres(sql), params);
      return (res.rows[0] as T) ?? undefined;
    },
    async run(sql: string, ...params: SqlValue[]): Promise<RunResult> {
      await ensureReady();
      return runWith((t, p) => pool.query(t, p), sql, params);
    },
    async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      await ensureReady();
      const client = await pool.connect();
      const q: QueryFn = (t, p) => client.query(t, p);
      const tx: Db = {
        async all<R = Record<string, unknown>>(sql: string, ...params: SqlValue[]): Promise<R[]> {
          return (await client.query(toPostgres(sql), params)).rows as R[];
        },
        async get<R = Record<string, unknown>>(sql: string, ...params: SqlValue[]): Promise<R | undefined> {
          return ((await client.query(toPostgres(sql), params)).rows[0] as R) ?? undefined;
        },
        async run(sql: string, ...params: SqlValue[]): Promise<RunResult> {
          return runWith(q, sql, params);
        },
        // Already inside a transaction — reuse this connection, no nested BEGIN.
        transaction<R>(inner: (tx: Db) => Promise<R>): Promise<R> {
          return inner(tx);
        },
        async close(): Promise<void> {
          /* the pool owns the client lifecycle; released below */
        },
      };
      try {
        await client.query("BEGIN");
        const result = await fn(tx);
        await client.query("COMMIT");
        return result;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    async close(): Promise<void> {
      await pool.end();
    },
  };
}
