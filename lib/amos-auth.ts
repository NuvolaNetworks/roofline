/**
 * Identity → org/user mapping for AMOS platform-IdP logins (Build & Sell B2).
 *
 * The verified X-Amos-Identity JWT carries the platform tenant in `org_id`.
 * Here that maps onto OUR orgs table via orgs.amos_tenant_id:
 *   - interactive login (/auth/amos) auto-provisions the org row on first
 *     login (amos_tenant_id from the token) and seeds the product defaults
 *     (templates, catalogue, automations) so a fresh org isn't empty;
 *   - API/MCP calls (lib/api-guard.ts) only LOOK UP the mapping and reject
 *     tokens whose tenant has no org yet — provisioning is an interactive act.
 *
 * Deliberately free of next/* imports so tests can exercise the mapping
 * outside a Next server.
 */
import { randomUUID } from "node:crypto";
import { getDb, type Db } from "./db.ts";
import type { AmosIdentity } from "./amos-identity.ts";
import {
  DEFAULT_CATALOGUE,
  DEFAULT_TEMPLATES,
  DEFAULT_AUTOMATIONS,
} from "./demo-fixtures.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/** Platform role claim → app role. Unknown roles get least privilege. */
export function mapPlatformRole(role: string | undefined): "admin" | "manager" | "rep" {
  switch ((role ?? "").toLowerCase()) {
    case "owner":
    case "admin":
      return "admin";
    case "manager":
      return "manager";
    default:
      return "rep";
  }
}

/** Our org id for a platform tenant, or null when no mapping exists. */
export async function findOrgByTenant(tenantId: string): Promise<string | null> {
  if (!isUuid(tenantId)) return null;
  const row = await getDb().get<{ id: string }>(
    "SELECT id FROM orgs WHERE amos_tenant_id = ?",
    tenantId,
  );
  return row?.id ?? null;
}

async function seedOrgDefaults(db: Db, orgId: string): Promise<void> {
  for (const [sku, name, unit, price, cost, source] of DEFAULT_CATALOGUE) {
    await db.run(
      "INSERT INTO catalogue (org_id, sku, name, unit, price_cents, cost_cents, source) VALUES (?,?,?,?,?,?,?)",
      orgId, sku, name, unit, price, cost, source,
    );
  }
  for (const [name, kind, fields] of DEFAULT_TEMPLATES) {
    await db.run(
      "INSERT INTO templates (org_id, name, kind, fields) VALUES (?,?,?,?)",
      orgId, name, kind, fields,
    );
  }
  for (const [name, trigger, action, channel, enabled] of DEFAULT_AUTOMATIONS) {
    await db.run(
      "INSERT INTO automations (org_id, name, trigger, action, channel, enabled, runs) VALUES (?,?,?,?,?,?,0)",
      orgId, name, trigger, action, channel, enabled,
    );
  }
}

/**
 * Map a verified identity into (org, user), creating either on first sight.
 * The user is matched inside the org by IdP subject first, then email, and
 * its name/role/email are refreshed from the token on every login.
 */
export async function provisionFromIdentity(
  identity: AmosIdentity,
): Promise<{ userId: number; orgId: string }> {
  if (!isUuid(identity.org_id)) {
    throw new Error("identity org_id is not a UUID");
  }
  const db = getDb();

  let orgId = (
    await db.get<{ id: string }>("SELECT id FROM orgs WHERE amos_tenant_id = ?", identity.org_id)
  )?.id;
  if (!orgId) {
    orgId = randomUUID();
    const name = identity.org_name?.trim() || `Org ${identity.org_id.slice(0, 8)}`;
    await db.run(
      "INSERT INTO orgs (id, name, amos_tenant_id) VALUES (?,?,?)",
      orgId, name, identity.org_id,
    );
    await seedOrgDefaults(db, orgId);
  }

  const role = mapPlatformRole(identity.role);
  const name = identity.name?.trim() || identity.email;
  const existing = await db.get<{ id: number }>(
    `SELECT id FROM users WHERE org_id = ? AND (amos_sub = ? OR email = ?)
     ORDER BY (amos_sub = ?) DESC LIMIT 1`,
    orgId, identity.sub, identity.email, identity.sub,
  );
  if (existing) {
    await db.run(
      "UPDATE users SET email = ?, name = ?, role = ?, amos_sub = ? WHERE id = ? AND org_id = ?",
      identity.email, name, role, identity.sub, existing.id, orgId,
    );
    return { userId: existing.id, orgId };
  }
  const inserted = await db.run(
    "INSERT INTO users (org_id, email, name, role, amos_sub) VALUES (?,?,?,?,?)",
    orgId, identity.email, name, role, identity.sub,
  );
  return { userId: inserted.lastId, orgId };
}
