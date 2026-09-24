// Persistence facade. With DATABASE_URL set this is Postgres via a pooled
// `pg` client (TLS in production) with idempotent migrations applied on
// first use; without it, the original node:sqlite demo database with seed
// data, so local dev and the demo tier need no services. Both back the same
// small async query interface. SQL throughout the app stays in the sqlite
// dialect it was born with; the Postgres adapter translates the few
// sqlite-isms (`?` placeholders, datetime()/date() helpers) — see
// lib/db-postgres.ts.
import { createSqliteDb } from "./db-sqlite.ts";
import { createPostgresDb } from "./db-postgres.ts";

/** Pipeline stages, per 8 Square's live board (assignment is its own stage). */
export const STAGES = [
  "New lead",
  "Assigned lead",
  "Prospect",
  "Approved",
  "Scheduled",
  "Completed/Invoiced",
  "Ready for Commission",
  "Closed",
] as const;
export type Stage = (typeof STAGES)[number];

/** Jobs belong to a workflow; a company runs several (roofing, construction…). */
export const WORKFLOWS = ["Roofing", "Construction", "Service"] as const;

export const COMMISSION_RATE = 0.1;

export type SqlValue = string | number | null;

export interface RunResult {
  /** Generated integer id of an INSERT (0 when the key isn't integral). */
  lastId: number;
  changes: number;
}

/** The one query surface both backends implement. */
export interface Db {
  all<T = Record<string, unknown>>(sql: string, ...params: SqlValue[]): Promise<T[]>;
  get<T = Record<string, unknown>>(sql: string, ...params: SqlValue[]): Promise<T | undefined>;
  run(sql: string, ...params: SqlValue[]): Promise<RunResult>;
  /** Run `fn` inside a single transaction, committing on success and rolling
   *  back on any throw. The passed handle runs on the transaction's own
   *  connection; use it (not the outer Db) for every statement inside. */
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

let instance: Db | null = null;

export function getDb(): Db {
  if (!instance) {
    const url = process.env.DATABASE_URL;
    instance = url ? createPostgresDb(url) : createSqliteDb();
  }
  return instance;
}

/** Close and forget the active connection — importer shutdown and tests. */
export async function closeDb(): Promise<void> {
  if (!instance) return;
  const db = instance;
  instance = null;
  await db.close();
}
