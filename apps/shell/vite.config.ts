import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { manifestPlugin } from "./vite-plugin-manifest.js";
import { serviceWorkerPlugin } from "./vite-plugin-sw.js";

const core = (p: string) => fileURLToPath(new URL(`../../packages/core/src/${p}`, import.meta.url));

// The base comes from the environment so the shell works on any static host
// under any path (a project Pages site is served under /<repository>/).
export default defineConfig({
  base: process.env["SUBSTACKER_BASE"] ?? "/",
  plugins: [react(), manifestPlugin(), serviceWorkerPlugin()],
  resolve: {
    alias: [
      { find: /^substacker-core\/dom$/, replacement: core("dom.ts") },
      { find: /^substacker-core\/react$/, replacement: core("react.ts") },
      { find: /^substacker-core$/, replacement: core("index.ts") },
    ],
  },
});
