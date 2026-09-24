import "pg";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { translateSql } from "./sql-compat.mjs";

export interface RunResult {
  lastInsertRowid: number;
  changes: number;
}

interface WorkerReply {
  ok: boolean;
  error?: string;
  rows?: Array<Record<string, unknown>>;
  rowCount?: number | null;
}

const WORKER_SOURCE = `
const { parentPort } = require("node:worker_threads");
const { Client, types } = require("pg");
const { writeFileSync, renameSync } = require("node:fs");
types.setTypeParser(20, (value) => Number(value));
types.setTypeParser(1700, (value) => Number(value));

let client = null;
let chain = Promise.resolve();

parentPort.on("message", (message) => {
  chain = chain.then(() => handle(message)).catch(() => {});
});

async function handle(message) {
  const finish = (body) => {
    const tmp = message.outPath + ".tmp";
    writeFileSync(tmp, JSON.stringify(body));
    renameSync(tmp, message.outPath);
  };
  try {
    if (!client) {
      client = new Client({
        connectionString: message.connectionString,
        ssl: message.ssl,
      });
      client.on("error", () => {});
      await client.connect();
    }
    if (message.type === "connect") {
      finish({ ok: true });
      return;
    }
    const result = await client.query(message.sql, message.params || []);
    finish({ ok: true, rows: result.rows, rowCount: result.rowCount });
  } catch (error) {
    finish({ ok: false, error: String(error && error.message ? error.message : error) });
  }
}
`;

function sslConfig(connectionString: string): false | { rejectUnauthorized: boolean } | undefined {
  const mode = (process.env.DATABASE_SSL || "").toLowerCase();
  if (mode === "disable" || mode === "off" || mode === "false") return false;
  if (mode === "no-verify") return { rejectUnauthorized: false };
  if (
    mode === "verify" ||
    mode === "require" ||
    connectionString.includes("sslmode=") ||
    connectionString.includes("rds.amazonaws.com")
  ) {
    const bundle = ["/app/rds-global-bundle.pem", "rds-global-bundle.pem"].find((path) =>
      existsSync(path),
    );
    return {
      rejectUnauthorized: true,
      ca: bundle ? readFileSync(bundle, "utf8") : undefined,
    };
  }
  return undefined;
}

let worker: Worker | null = null;
let nextId = 0;

function bridge(): Worker {
  if (worker) return worker;
  worker = new Worker(WORKER_SOURCE, { eval: true });
  worker.unref();
  return worker;
}

function call(message: Record<string, unknown>): WorkerReply {
  const id = ++nextId;
  const outPath = join(tmpdir(), `roofline-pg-${process.pid}-${id}.json`);
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not set");
  bridge().postMessage({
    ...message,
    id,
    outPath,
    connectionString,
    ssl: sslConfig(connectionString),
  });
  const sleep = new Int32Array(new SharedArrayBuffer(4));
  const started = Date.now();
  while (!existsReady(outPath)) {
    if (Date.now() - started > 30_000) throw new Error("Roofline database call timed out");
    Atomics.wait(sleep, 0, 0, 25);
  }
  const body = JSON.parse(readFileSync(outPath, "utf8")) as WorkerReply;
  if (!body.ok) throw new Error(body.error || "Roofline database call failed");
  return body;
}

function existsReady(path: string): boolean {
  try {
    return readFileSync(path, "utf8").length > 0;
  } catch {
    return false;
  }
}

export function queryRaw(sql: string, params: unknown[] = []): WorkerReply {
  return call({ type: "query", sql, params });
}

export function query(sql: string, params: unknown[] = []): WorkerReply {
  return queryRaw(translateSql(sql), params);
}

export function statement(sql: string) {
  const translated = translateSql(sql);
  const insert = /^\s*insert\b/i.test(translated) && !/\breturning\b/i.test(translated);
  const text = insert ? `${translated.replace(/;\s*$/, "")} RETURNING id` : translated;
  return {
    get(...params: unknown[]) {
      return queryRaw(text, params).rows?.[0];
    },
    all(...params: unknown[]) {
      return queryRaw(text, params).rows ?? [];
    },
    run(...params: unknown[]): RunResult {
      const result = queryRaw(text, params);
      const id = Number(result.rows?.[0]?.id ?? 0);
      return {
        lastInsertRowid: Number.isFinite(id) ? id : 0,
        changes: result.rowCount ?? 0,
      };
    },
  };
}

export function execScript(sql: string): void {
  for (const part of sql
    .split(/;\s*(?:\n|$)/)
    .map((part) => part.trim())
    .filter(Boolean)) {
    queryRaw(part);
  }
}
