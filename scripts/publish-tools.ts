// Print the app_mcp_publish payload for the tool registry (lib/tools.ts):
//   node scripts/publish-tools.ts > tools.json
// and regenerate the `mcp:` section of amos.yaml with --write-manifest.
import { readFileSync, writeFileSync } from "node:fs";
import { publishPayload } from "../lib/tools.ts";

const tools = publishPayload();
if (process.argv.includes("--write-manifest")) {
  const path = new URL("../amos.yaml", import.meta.url);
  const yaml = readFileSync(path, "utf8");
  const head = yaml.slice(0, yaml.indexOf("mcp:"));
  const q = (s: string) => JSON.stringify(s);
  const body = tools
    .map((t) =>
      [
        `    - name: ${t.name}`,
        `      description: ${q(String(t.description))}`,
        `      http_method: ${t.http_method}`,
        `      http_path: ${t.http_path}`,
        `      classification: ${t.classification}`,
      ].join("\n"),
    )
    .join("\n");
  writeFileSync(
    path,
    `${head}mcp:\n  # Generated from lib/tools.ts by scripts/publish-tools.ts --write-manifest.\n  # The live surface is published with the receipted app_mcp_publish verb.\n  tools:\n${body}\n`,
  );
  console.error(`amos.yaml: ${tools.length} tools`);
} else {
  console.log(JSON.stringify(tools, null, 2));
}
