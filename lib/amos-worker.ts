// In-process delivery loop for the AMOS outbox. Started once at boot from
// instrumentation.ts; `kickAmosOutbox()` drains immediately after a message
// is enqueued so a signing email doesn't wait for the next tick. Single
// flight per process; the outbox's conditional claim keeps several
// processes from double-sending.
import { getDb } from "./db.ts";
import { drain } from "./amos-outbox.ts";
import { amosTransport } from "./amos-link.ts";
import { runDueCommissionStatements } from "./commission.ts";

const TICK_MS = 15_000;
let running: Promise<void> | null = null;
let started = false;

async function once(): Promise<void> {
  const db = getDb();
  const stats = await drain(db, amosTransport(db));
  if (stats.delivered || stats.retried || stats.dead) {
    console.log(`[roofline] amos outbox: ${stats.delivered} delivered, ${stats.retried} retrying, ${stats.dead} dead`);
  }
}

export function kickAmosOutbox(): void {
  if (running) return;
  running = once()
    .catch((err) => console.error("[roofline] amos outbox drain failed:", err))
    .finally(() => {
      running = null;
    });
}

// Commission statements: checked hourly; they queue only on the 1st and
// 15th (company time), once per rep per period, then drain like any message.
const STATEMENT_CHECK_MS = 60 * 60 * 1000;

async function commissionPass(): Promise<void> {
  const queued = await runDueCommissionStatements(getDb());
  if (queued) {
    console.log(`[roofline] commission statements: ${queued} queued`);
    kickAmosOutbox();
  }
}

export function startAmosWorker(): void {
  if (started) return;
  started = true;
  setInterval(kickAmosOutbox, TICK_MS).unref();
  kickAmosOutbox();
  const statements = () => commissionPass().catch((err) => console.error("[roofline] commission statements failed:", err));
  setInterval(statements, STATEMENT_CHECK_MS).unref();
  statements();
}
