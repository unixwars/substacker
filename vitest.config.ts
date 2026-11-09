import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const src = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Unit tests: pure logic, no network, no browser. Integration tests have their
// own config (vitest.integration.config.ts) and the *.integration.test.ts suffix.
export default defineConfig({
  resolve: {
    alias: [
      { find: /^substacker-core\/dom$/, replacement: src("./packages/core/src/dom.ts") },
      { find: /^substacker-core\/react$/, replacement: src("./packages/core/src/react.ts") },
      { find: /^substacker-core$/, replacement: src("./packages/core/src/index.ts") },
    ],
  },
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.{ts,tsx}"],
    exclude: ["**/*.integration.test.ts", "**/node_modules/**", "**/dist/**", "apps/*/e2e/**"],
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**", "apps/*/src/**"],
      exclude: ["**/*.test.{ts,tsx}", "**/*.integration.test.ts"],
      reporter: ["text-summary", "lcov", "json-summary"],
      reportsDirectory: "coverage",
    },
  },
});
