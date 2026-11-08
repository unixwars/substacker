import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const src = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Integration tests: whole flows (scrape then build against fixture feeds served
// by a local HTTP server or an injected fetch) and the pack-and-import install
// check. No external network except the npm registry in the install check.
export default defineConfig({
  resolve: {
    alias: [
      { find: /^substacker-core\/dom$/, replacement: src("./packages/core/src/dom.ts") },
      { find: /^substacker-core\/react$/, replacement: src("./packages/core/src/react.ts") },
      { find: /^substacker-core$/, replacement: src("./packages/core/src/index.ts") },
    ],
  },
  test: {
    include: ["{packages,apps}/*/src/**/*.integration.test.ts", "test/**/*.integration.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
