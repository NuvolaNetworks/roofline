import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: [],
  // Template logos and spec-sheet PDFs upload through server actions; the
  // 1 MB default is smaller than a typical manufacturer spec sheet. Files
  // are capped per-upload in lib/files.ts (MAX_FILE_BYTES).
  experimental: { serverActions: { bodySizeLimit: "16mb" } },
  // The AMOS app channel looks for the service key at a well-known path;
  // app-router folders can't start with a dot, so route it.
  async rewrites() {
    return [{ source: "/.well-known/amos-app-service-key.json", destination: "/api/amos/service-key" }];
  },
};

export default nextConfig;
