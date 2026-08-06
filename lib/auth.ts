// Session auth without dependencies: HMAC-signed cookie carrying the user id.
// Demo-grade on purpose; phase 2 replaces login with AMOS app end-user auth
// (the platform's B2 surface) while everything below `currentUser()` keeps
// working unchanged.
import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { getDb } from "./db";

const SECRET = process.env.ROOFLINE_SESSION_SECRET || "roofline-demo-secret";
const COOKIE = "roofline_session";

export interface User {
  id: number;
  email: string;
  name: string;
  role: "admin" | "manager" | "rep";
  manager_id: number | null;
}

function sign(value: string): string {
  return createHmac("sha256", SECRET).update(value).digest("hex");
}

export async function login(email: string, password: string): Promise<boolean> {
  const row = getDb()
    .prepare("SELECT id, password FROM users WHERE email = ?")
    .get(email) as { id: number; password: string } | undefined;
  if (!row || row.password !== password) return false;
  const payload = String(row.id);
  (await cookies()).set(COOKIE, `${payload}.${sign(payload)}`, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 12,
  });
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
  const user = getDb()
    .prepare("SELECT id, email, name, role, manager_id FROM users WHERE id = ?")
    .get(Number(payload)) as User | undefined;
  return user ?? null;
}

/** The user ids whose jobs this user may see: reps see themselves; managers
 * and admins see their whole subtree. */
export function visibleUserIds(user: User): number[] {
  if (user.role === "rep") return [user.id];
  const all = getDb()
    .prepare("SELECT id, manager_id FROM users")
    .all() as Array<{ id: number; manager_id: number | null }>;
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
