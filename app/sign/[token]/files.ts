// Which stored files a signing link may serve: only those frozen into its
// envelope's snapshot (logo + attachments) — never an arbitrary org file.
import type { RenderModel } from "@/lib/proposal-model";

export function snapshotFileIds(model: RenderModel): Set<number> {
  const ids = new Set<number>();
  if (model.logo) ids.add(model.logo.file_id);
  for (const b of model.blocks) if (b.type === "attachments") b.files.forEach((f) => ids.add(f.file_id));
  return ids;
}
