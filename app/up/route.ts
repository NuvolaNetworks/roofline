// ALB health check. When the managed database is configured, a task that
// cannot read it stays unhealthy so the previous task keeps serving.
import { getDb } from "@/lib/db";

export function GET() {
  if (process.env.DATABASE_URL) {
    try {
      getDb().prepare("SELECT 1 AS ok").get();
    } catch (error) {
      console.error("roofline database is not reachable", error);
      return new Response("db", { status: 500 });
    }
  }
  return new Response("ok");
}
