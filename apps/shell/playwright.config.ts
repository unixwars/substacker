import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: process.env["CI"] ? 1 : 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: { baseURL: "http://127.0.0.1:4173", trace: "retain-on-failure" },
  webServer: { command: "node e2e/serve.mjs", url: "http://127.0.0.1:4173/main/", reuseExistingServer: !process.env["CI"] },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
