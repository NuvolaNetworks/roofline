/**
 * Every /api route is reachable only with a platform-minted identity token.
 * These routes back the published MCP tool surface, so AMOS is the only
 * legitimate caller — a direct request without a valid `X-Amos-Identity`
 * carries no identity and is refused.
 *
 * Beyond identity, the routes are org-scoped: the token's org claim (the
 * platform tenant) must map to an orgs row here. Tokens for tenants nobody
 * has provisioned (an owner signing in at /auth/amos) are rejected — the MCP
 * surface never conjures an org into being.
 */
import { verifyAmosIdentity, type AmosIdentity } from "./amos-identity.ts";
import { findOrgByTenant, visibleUserIdsForIdentity } from "./amos-auth.ts";
import type { SqlValue } from "./db.ts";

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

/** Identity + resolved org id — the guard every business route uses. */
export async function requireOrgIdentity(
  req: Request,
): Promise<{ identity: AmosIdentity; orgId: string } | { error: Response }> {
  const auth = await requireIdentity(req);
  if ("error" in auth) return auth;
  const orgId = await findOrgByTenant(auth.identity.org_id);
  if (!orgId) {
    return {
      error: Response.json(
        {
          error:
            "forbidden — this tenant has no Roofline org yet; an owner must sign in to the app once to provision it",
        },
        { status: 403 },
      ),
    };
  }
  return { identity: auth.identity, orgId };
}

/**
 * Build the rep-scoping fragment for a jobs query, mirroring the UI's
 * visibleUserIds fencing (see lib/amos-auth). Returns a SQL fragment plus its
 * params to splice after an existing WHERE, e.g.
 *   `SELECT ... FROM jobs j WHERE j.org_id = ?` + clause.sql
 * `column` is the assignee column to filter (qualified when the query joins).
 */
export async function repScopeClause(
  orgId: string,
  identity: AmosIdentity,
  column = "assignee_id",
): Promise<{ sql: string; params: SqlValue[] }> {
  const ids = await visibleUserIdsForIdentity(orgId, identity);
  if (ids === null) return { sql: "", params: [] }; // whole org
  if (ids.length === 0) return { sql: " AND 1 = 0", params: [] }; // sees nothing
  return {
    sql: ` AND ${column} IN (${ids.map(() => "?").join(",")})`,
    params: ids,
  };
}
