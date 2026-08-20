// Session auth without dependencies: HMAC-signed cookie carrying the user id.
// Two login modes, one session shape:
//   AUTH_MODE=demo — email/password against the seeded demo users (sqlite).
//   AUTH_MODE=amos — the AMOS platform IdP owns signup/login; the callback at
//     /auth/amos verifies the X-Amos-Identity EdDSA JWT, provisions the
//     org+user rows, then sets this same cookie.
// Default mode is amos when DATABASE_URL is set, demo otherwise. Everything
// below currentUser() is mode-agnostic: the session resolves to a users row,
// and that row's org_id scopes every query.
import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { getDb } from "./db";

const SECRET = process.env.ROOFLINE_SESSION_SECRET || "roofline-demo-secret";
const COOKIE = "roofline_session";

export type AuthMode = "amos" | "demo";

export function authMode(): AuthMode {
  const mode = process.env.AUTH_MODE;
  if (mode === "amos" || mode === "demo") return mode;
  return process.env.DATABASE_URL ? "amos" : "demo";
}

export interface User {
  id: number;
  org_id: string;
  email: string;
  name: string;
  role: "admin" | "manager" | "rep";
  manager_id: number | null;
}

function sign(value: string): string {
  return createHmac("sha256", SECRET).update(value).digest("hex");
}

/** Set the session cookie for a users row — shared by both login modes. */
export async function establishSession(userId: number): Promise<void> {
  const payload = String(userId);
  (await cookies()).set(COOKIE, `${payload}.${sign(payload)}`, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 12,
  });
}

/** Demo-mode password login. Refused outright in amos mode. */
export async function login(email: string, password: string): Promise<boolean> {
  if (authMode() !== "demo") return false;
  const row = await getDb().get<{ id: number; password: string | null }>(
    "SELECT id, password FROM users WHERE email = ?",
    email,
  );
  if (!row || !row.password || row.password !== password) return false;
  await establishSession(row.id);
  return true;
}

export async function logout(): Promise<void> {
  (await cookies()).delete(COOKIE);
}

export async function currentUser(): Promise<User | null> {
  const raw = (await cookies()).get(COOKIE)?.value;
  if (!raw) return null;
  const dot = raw.lastIndexOf(".");
  if (dot < 1) return null;
  const payload = raw.slice(0, dot);
  const mac = raw.slice(dot + 1);
  const expect = sign(payload);
  if (
    mac.length !== expect.length ||
    !timingSafeEqual(Buffer.from(mac), Buffer.from(expect))
  ) {
    return null;
  }
  const user = await getDb().get<User>(
    "SELECT id, org_id, email, name, role, manager_id FROM users WHERE id = ?",
    Number(payload),
  );
  return user ?? null;
}

/** The user ids whose jobs this user may see: reps see themselves; managers
 * and admins see their whole subtree. Org-fenced — only this org's users. */
export async function visibleUserIds(user: User): Promise<number[]> {
  if (user.role === "rep") return [user.id];
  const all = await getDb().all<{ id: number; manager_id: number | null }>(
    "SELECT id, manager_id FROM users WHERE org_id = ?",
    user.org_id,
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
