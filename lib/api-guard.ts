/**
 * Every /api route is reachable only with a platform-minted identity token.
 * These routes back the published MCP tool surface, so AMOS is the only
 * legitimate caller — a direct request without a valid `X-Amos-Identity`
 * carries no identity and is refused.
 */
import { verifyAmosIdentity, type AmosIdentity } from "./amos-identity";

export async function requireIdentity(
  req: Request,
): Promise<{ identity: AmosIdentity } | { error: Response }> {
  const identity = await verifyAmosIdentity(req.headers.get("x-amos-identity"));
  if (!identity) {
    return {
      error: Response.json(
        {
          error:
            "unauthorized — this endpoint requires a platform-minted X-Amos-Identity token (connect through the app's AMOS MCP endpoint)",
        },
        { status: 401 },
      ),
    };
  }
  return { identity };
}

/** Role → which reps' jobs this identity may see (mirrors the UI's fencing). */
export function scopeForRole(role: string, email: string) {
  return { role, email, repScoped: role === "member" };
}
