import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "cloudflare:workers": fileURLToPath(
        new URL("./test/helpers/cloudflare-workers.ts", import.meta.url)
      ),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    globals: false,
    server: {
      deps: {
        // Inline so the `cloudflare:workers` alias applies to its import too.
        inline: ["@cloudflare/workers-oauth-provider"],
      },
    },
  },
});
