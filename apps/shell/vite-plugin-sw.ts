import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { build } from "vite";
import { precacheList } from "./src/sw/precache.js";

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const core = (p: string) => fileURLToPath(new URL(`../../packages/core/src/${p}`, import.meta.url));

/**
 * After the shell is built, list what it emitted and build the service worker with
 * that list baked in (a hand-written list cannot know Vite's hashed names).
 */
export function serviceWorkerPlugin(): Plugin {
  let outDir = "";
  let root = "";
  return {
    name: "substacker-service-worker",
    apply: "build",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
      root = config.root;
    },
    async closeBundle() {
      const files = walk(outDir).map((f) => relative(outDir, f));
      const list = precacheList(files);
      const buildId = createHash("sha256").update(list.join("\n")).update(files.filter((f) => f.startsWith("assets/")).join("\n")).digest("hex").slice(0, 12);
      await build({
        root,
        configFile: false,
        logLevel: "warn",
        define: { __PRECACHE__: JSON.stringify(list), __BUILD_ID__: JSON.stringify(buildId) },
        resolve: {
          alias: [{ find: /^substacker-core$/, replacement: core("index.ts") }],
        },
        build: {
          outDir,
          emptyOutDir: false,
          copyPublicDir: false,
          minify: true,
          lib: { entry: join(root, "src/sw/sw.ts"), formats: ["iife"], name: "substackerSw", fileName: () => "sw.js" },
        },
      });
    },
  };
}
