import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "cloudflare:workers": path.resolve(import.meta.dirname, "test/mocks/cloudflare-workers.ts"),
    },
  },
  test: {
    server: {
      deps: {
        inline: ["@cloudflare/workers-oauth-provider"],
      },
    },
  },
});
