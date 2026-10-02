"use server";

// Template builder actions. Admins and managers edit templates; reps use
// them. Each action loads the stored body, applies one change, normalises
// and saves — so a malformed form post can't store a malformed template.
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getDb } from "./db";
import { currentUser, type User } from "./auth";
import {
  blankBlock,
  normalizeAccent,
  normalizeTemplate,
  parseTemplateBody,
  type Block,
  type BlockType,
  type TemplateBody,
} from "./doc-template";
import { FileRejected, formFile, putFile } from "./files";
import { orgName } from "./proposal-data";

async function requireEditor(): Promise<User> {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (user.role === "rep") redirect("/templates?error=" + encodeURIComponent("Only admins and managers can edit templates."));
  return user;
}

const editor = (id: number, q = "") => `/templates/${id}${q ? `?${q}` : ""}`;
const fail = (id: number, message: string): never => redirect(editor(id, `error=${encodeURIComponent(message)}`));
const text = (v: FormDataEntryValue | null, max: number) => String(v ?? "").slice(0, max);

async function load(user: User, id: number): Promise<TemplateBody> {
  const db = getDb();
  const row = await db.get<{ body: string | null }>(
    "SELECT body FROM templates WHERE id = ? AND org_id = ? AND kind = 'proposal'",
    id, user.org_id,
  );
  if (!row) redirect("/templates");
  return parseTemplateBody(row.body, await orgName(db, user.org_id));
}

async function save(user: User, id: number, body: TemplateBody, name?: string) {
  const clean = normalizeTemplate(body, body.branding.company_name);
  await getDb().run(
    `UPDATE templates SET body = ?, updated_at = datetime('now')${name ? ", name = ?" : ""} WHERE id = ? AND org_id = ?`,
    ...(name ? [JSON.stringify(clean), name, id, user.org_id] : [JSON.stringify(clean), id, user.org_id]),
  );
  revalidatePath(editor(id));
  revalidatePath("/templates");
}

async function edit(id: number, fn: (body: TemplateBody, user: User) => void | Promise<void>) {
  const user = await requireEditor();
  const body = await load(user, id);
  await fn(body, user);
  await save(user, id, body);
}

const findBlock = (body: TemplateBody, blockId: string) => body.blocks.find((b) => b.id === blockId);

// ── Templates ─────────────────────────────────────────────────────────

export async function createTemplate(formData: FormData) {
  const user = await requireEditor();
  const db = getDb();
  const sourceId = Number(formData.get("copy_from") || 0);
  let body: TemplateBody;
  if (sourceId) {
    const src = await db.get<{ body: string | null }>("SELECT body FROM templates WHERE id = ? AND org_id = ?", sourceId, user.org_id);
    body = parseTemplateBody(src?.body ?? null, await orgName(db, user.org_id));
  } else {
    body = parseTemplateBody(null, await orgName(db, user.org_id));
  }
  const name = text(formData.get("name"), 120).trim() || "New proposal template";
  const r = await db.run(
    "INSERT INTO templates (org_id, name, kind, fields, body, updated_at) VALUES (?,?, 'proposal', 'line items, customer, total', ?, datetime('now'))",
    user.org_id, name, JSON.stringify(body),
  );
  revalidatePath("/templates");
  redirect(editor(r.lastId));
}

export async function updateBranding(id: number, formData: FormData) {
  const user = await requireEditor();
  const body = await load(user, id);
  const b = body.branding;
  b.company_name = text(formData.get("company_name"), 120).trim();
  b.tagline = text(formData.get("tagline"), 160).trim();
  b.accent = normalizeAccent(formData.get("accent"));
  b.phone = text(formData.get("phone"), 40).trim();
  b.stats = [0, 1, 2, 3].map((i) => ({
    value: text(formData.get(`stat_value_${i}`), 24).trim(),
    label: text(formData.get(`stat_label_${i}`), 40).trim(),
  }));
  if (formData.get("remove_logo") === "yes") b.logo_file_id = null;
  const logo = await formFile(formData, "logo");
  if (logo) {
    try {
      b.logo_file_id = (await putFile(getDb(), user.org_id, "logo", logo.name, logo.bytes, ["image/png", "image/jpeg"])).id;
    } catch (e) {
      if (e instanceof FileRejected) fail(id, `Logo: ${e.message}`);
      throw e;
    }
  }
  await save(user, id, body, text(formData.get("name"), 120).trim() || undefined);
}

// ── Blocks ────────────────────────────────────────────────────────────

export async function addBlock(id: number, formData: FormData) {
  const type = String(formData.get("type")) as BlockType;
  if (!["cover", "line_items", "summary", "attachments", "text"].includes(type)) return;
  await edit(id, (body) => {
    body.blocks.push(blankBlock(type));
  });
}

export async function moveBlock(id: number, blockId: string, dir: -1 | 1) {
  await edit(id, (body) => {
    const i = body.blocks.findIndex((b) => b.id === blockId);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= body.blocks.length) return;
    [body.blocks[i], body.blocks[j]] = [body.blocks[j], body.blocks[i]];
  });
}

export async function deleteBlock(id: number, blockId: string) {
  await edit(id, (body) => {
    body.blocks = body.blocks.filter((b) => b.id !== blockId);
  });
}

export async function updateBlock(id: number, blockId: string, formData: FormData) {
  await edit(id, (body) => {
    const b = findBlock(body, blockId) as Block | undefined;
    if (!b) return;
    b.title = text(formData.get("title"), 120);
    const on = (k: string) => formData.get(k) === "yes";
    switch (b.type) {
      case "line_items":
        b.show_prices = on("show_prices");
        b.show_subtotal = on("show_subtotal");
        break;
      case "summary":
        b.intro = text(formData.get("intro"), 2000);
        b.consent = text(formData.get("consent"), 2000);
        b.contractor_signs = on("contractor_signs");
        break;
      case "attachments":
        b.include_catalogue_specs = on("include_catalogue_specs");
        break;
      case "text":
        b.body = text(formData.get("body"), 60_000);
        break;
    }
  });
}

export async function uploadAttachment(id: number, blockId: string, formData: FormData) {
  const user = await requireEditor();
  const body = await load(user, id);
  const b = findBlock(body, blockId);
  if (!b || b.type !== "attachments") return;
  const files = formData.getAll("files").filter((f): f is File => typeof f !== "string" && f.size > 0);
  try {
    for (const f of files) {
      const stored = await putFile(getDb(), user.org_id, "attachment", f.name, new Uint8Array(await f.arrayBuffer()));
      b.file_ids.push(stored.id);
    }
  } catch (e) {
    if (e instanceof FileRejected) fail(id, e.message);
    throw e;
  }
  await save(user, id, body);
}

export async function removeAttachment(id: number, blockId: string, fileId: number) {
  await edit(id, (body) => {
    const b = findBlock(body, blockId);
    if (b?.type === "attachments") b.file_ids = b.file_ids.filter((f) => f !== fileId);
  });
}
