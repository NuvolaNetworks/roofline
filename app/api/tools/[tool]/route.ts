// The AI tool surface (lib/tools.ts): GET for reads (arguments in the query
// string), POST for writes (JSON body). Reached through the app's AMOS MCP
// endpoint, which verifies the caller and sends X-Amos-Identity.
import { getDb } from "@/lib/db";
import { requireOrgIdentity } from "@/lib/api-guard";
import { runTool, toolContext, TOOLS_BY_NAME } from "@/lib/tools";
import { requestOrigin } from "@/lib/request-origin";
import { kickAmosOutbox } from "@/lib/amos-worker";

export const dynamic = "force-dynamic";

async function handle(req: Request, name: string, args: Record<string, unknown>, method: "GET" | "POST") {
  const tool = TOOLS_BY_NAME.get(name);
  if (!tool) return Response.json({ error: `unknown tool ${name}` }, { status: 404 });
  if ((tool.classification === "read") !== (method === "GET")) {
    return Response.json({ error: `${name} is a ${tool.classification}; use ${tool.classification === "read" ? "GET" : "POST"}` }, { status: 405 });
  }
  const auth = await requireOrgIdentity(req);
  if ("error" in auth) return auth.error;
  const ctx = await toolContext(getDb(), auth.orgId, auth.identity, await requestOrigin());
  const { status, body } = await runTool(ctx, name, args);
  if (tool.classification === "write") kickAmosOutbox();
  return Response.json(body, { status });
}

export async function GET(req: Request, { params }: { params: Promise<{ tool: string }> }) {
  const { tool } = await params;
  const args = Object.fromEntries(new URL(req.url).searchParams.entries());
  return handle(req, tool, args, "GET");
}

export async function POST(req: Request, { params }: { params: Promise<{ tool: string }> }) {
  const { tool } = await params;
  const args = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  return handle(req, tool, typeof args === "object" && args ? args : {}, "POST");
}
