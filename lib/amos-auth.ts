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
import { randomBytes, randomUUID } from "node:crypto";
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

/** A random, non-enumerable, revocable token for the public estimator link
 *  (H1). ~256 bits of entropy, url-safe. Rotating it invalidates old signs. */
export function newEstimatorToken(): string {
  return randomBytes(32).toString("base64url");
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

interface AppUser {
  id: number;
  role: "admin" | "manager" | "rep";
  manager_id: number | null;
}

/**
 * Look up the app user backing a verified identity within an org — read-only
 * (provisioning is an interactive act). Matches by IdP subject first, then
 * email, exactly like provisionFromIdentity.
 */
export async function findUserForIdentity(
  orgId: string,
  identity: AmosIdentity,
): Promise<AppUser | null> {
  return (
    (await getDb().get<AppUser>(
      `SELECT id, role, manager_id FROM users
       WHERE org_id = ? AND (amos_sub = ? OR email = ?)
       ORDER BY (amos_sub = ?) DESC LIMIT 1`,
      orgId, identity.sub, identity.email, identity.sub,
    )) ?? null
  );
}

/**
 * The user ids whose jobs an /api identity may see, mirroring the UI's
 * visibleUserIds fencing so the MCP surface is not more permissive than the
 * app: a user is scoped to their own manager subtree (rep → self only).
 *
 * Returns null to mean "no rep filter — the whole org" (used only for a
 * privileged identity with no provisioned user row to anchor a subtree).
 * Fails closed: a rep-level identity with no user row sees nothing ([]).
 */
export async function visibleUserIdsForIdentity(
  orgId: string,
  identity: AmosIdentity,
): Promise<number[] | null> {
  const user = await findUserForIdentity(orgId, identity);
  if (!user) {
    // No row to anchor a subtree: reps see nothing; admins/managers (the
    // privileged roles) fall back to the whole org rather than being locked
    // out of their own MCP surface.
    return mapPlatformRole(identity.role) === "rep" ? [] : null;
  }
  const all = await getDb().all<{ id: number; manager_id: number | null }>(
    "SELECT id, manager_id FROM users WHERE org_id = ?",
    orgId,
  );
  const children = new Map<number | null, number[]>();
  for (const u of all) {
    const list = children.get(u.manager_id) ?? [];
    list.push(u.id);
    children.set(u.manager_id, list);
  }
  const out: number[] = [];
  const stack = [user.id];
  while (stack.length) {
    const id = stack.pop()!;
    out.push(id);
    for (const c of children.get(id) ?? []) stack.push(c);
  }
  return out;
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

  // One transaction (M4): concurrent first-logins used to race between the
  // existence check and the INSERT, and the loser 500'd on the amos_tenant_id
  // UNIQUE constraint. INSERT ... ON CONFLICT DO NOTHING + re-select makes it
  // safe — the loser simply adopts the winner's org — and the whole provision
  // (org + defaults + user) commits atomically.
  return getDb().transaction(async (tx) => {
    const candidateOrgId = randomUUID();
    const orgName = identity.org_name?.trim() || `Org ${identity.org_id.slice(0, 8)}`;
    const created = await tx.run(
      `INSERT INTO orgs (id, name, amos_tenant_id, estimator_token) VALUES (?,?,?,?)
       ON CONFLICT (amos_tenant_id) DO NOTHING`,
      candidateOrgId, orgName, identity.org_id, newEstimatorToken(),
    );
    // Seed product defaults only for the writer that actually created the org.
    if (created.changes > 0) {
      await seedOrgDefaults(tx, candidateOrgId);
    }
    // Re-select resolves the org whether we won the insert or adopted an
    // existing one (own or a concurrent winner's).
    const orgId = (
      await tx.get<{ id: string }>(
        "SELECT id FROM orgs WHERE amos_tenant_id = ?",
        identity.org_id,
      )
    )!.id;

    const role = mapPlatformRole(identity.role);
    const name = identity.name?.trim() || identity.email;
    const existing = await tx.get<{ id: number }>(
      `SELECT id FROM users WHERE org_id = ? AND (amos_sub = ? OR email = ?)
       ORDER BY (amos_sub = ?) DESC LIMIT 1`,
      orgId, identity.sub, identity.email, identity.sub,
    );
    if (existing) {
      await tx.run(
        "UPDATE users SET email = ?, name = ?, role = ?, amos_sub = ? WHERE id = ? AND org_id = ?",
        identity.email, name, role, identity.sub, existing.id, orgId,
      );
      return { userId: existing.id, orgId };
    }
    const inserted = await tx.run(
      "INSERT INTO users (org_id, email, name, role, amos_sub) VALUES (?,?,?,?,?)",
      orgId, identity.email, name, role, identity.sub,
    );
    return { userId: inserted.lastId, orgId };
  });
}
