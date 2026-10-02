"use server";

// Catalog upkeep: add items, set the proposal section an item lands in,
// and attach a manufacturer spec sheet that rides along on any proposal
// containing the item. Admins and managers only.
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getDb } from "./db";
import { currentUser, type User } from "./auth";
import { FileRejected, formFile, putFile } from "./files";

async function requireEditor(): Promise<User> {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (user.role === "rep") redirect("/catalogue?error=" + encodeURIComponent("Only admins and managers can edit the catalog."));
  return user;
}

const fail = (message: string): never => redirect(`/catalogue?error=${encodeURIComponent(message)}`);
const text = (v: FormDataEntryValue | null, max: number) => String(v ?? "").trim().slice(0, max);
const cents = (v: FormDataEntryValue | null) => {
  const n = Number(String(v ?? "").replace(/[$,\s]/g, ""));
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : 0;
};

export async function addCatalogueItem(formData: FormData) {
  const user = await requireEditor();
  const db = getDb();
  const name = text(formData.get("name"), 200);
  if (!name) fail("Give the item a name.");
  const sku = text(formData.get("sku"), 60).toUpperCase().replace(/[^A-Z0-9.\-_]/g, "-") || `CUSTOM-${Date.now().toString(36).toUpperCase()}`;
  const dup = await db.get("SELECT id FROM catalogue WHERE org_id = ? AND sku = ?", user.org_id, sku);
  if (dup) fail(`SKU ${sku} already exists.`);
  await db.run(
    "INSERT INTO catalogue (org_id, sku, name, unit, price_cents, cost_cents, source, section) VALUES (?,?,?,?,?,?, 'custom', ?)",
    user.org_id, sku, name, text(formData.get("unit"), 30) || "each",
    cents(formData.get("price")), cents(formData.get("cost")), text(formData.get("section"), 120),
  );
  revalidatePath("/catalogue");
}

export async function updateCatalogueItem(id: number, formData: FormData) {
  const user = await requireEditor();
  const db = getDb();
  await db.run("UPDATE catalogue SET section = ? WHERE id = ? AND org_id = ?", text(formData.get("section"), 120), id, user.org_id);
  const spec = await formFile(formData, "spec");
  if (spec) {
    try {
      const f = await putFile(db, user.org_id, "attachment", spec.name, spec.bytes);
      await db.run("UPDATE catalogue SET spec_file_id = ? WHERE id = ? AND org_id = ?", f.id, id, user.org_id);
    } catch (e) {
      if (e instanceof FileRejected) fail(e.message);
      throw e;
    }
  }
  if (formData.get("remove_spec") === "yes") {
    await db.run("UPDATE catalogue SET spec_file_id = NULL WHERE id = ? AND org_id = ?", id, user.org_id);
  }
  revalidatePath("/catalogue");
}
