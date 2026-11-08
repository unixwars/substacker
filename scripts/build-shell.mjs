// Builds the shell into <out> with config.json written from the resolved
// configuration (SUBSTACKER_CONFIG, else substacker.config.local.json).
//   node scripts/build-shell.mjs --out site [--base ./]
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildShell, readIfExists, scraperModule, shellConfigFor } from "./site.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const out = resolve(option("--out", "site"));
const base = option("--base", "./");

const { loadConfig } = await scraperModule("config");
const config = loadConfig(process.env, readIfExists);
const scratch = mkdtempSync(join(tmpdir(), "substacker-shell-"));
try {
  await buildShell({ outDir: out, shellConfig: shellConfigFor(config), scratchDir: scratch, base });
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
console.log(`shell built in ${out}`);
