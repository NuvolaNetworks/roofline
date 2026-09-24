/**
 * Migrate-on-boot: when the server starts against Postgres, apply
 * migrations/*.sql before the first request instead of on it. The adapter
 * would run them lazily anyway (single-flight, advisory-locked); this just
 * moves the cost to startup where a failure is loud.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (!process.env.DATABASE_URL) return;
  const { getDb } = await import("./lib/db");
  await getDb().get("SELECT 1 AS ok");
  console.log("[roofline] database migrations applied");
}
