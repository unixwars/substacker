// Shared by the publish workflow, the publish dry run and the shell end-to-end
// preparation: how the Pages site is assembled (the shell at the root, the served
// content under content/). Plain Node, no dependencies; run `npm run build` first,
// it uses the built scraper.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const shellDir = join(root, "apps", "shell");
export const scraperDist = join(root, "packages", "scraper", "dist");

/** The release number, from the root package.json (shipped in the container image too). */
export function packageVersion() {
  return JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
}

/** Pages allows about 1 GB; the workflow fails above this. */
export const SITE_LIMIT_BYTES = 800 * 1024 * 1024;

/** The built scraper's modules (`config`, `build`, `feed`, `derive`, ...). */
export async function scraperModule(name) {
  const file = join(scraperDist, `${name}.js`);
  if (!existsSync(file)) throw new Error("Build the workspace first: npm run build");
  return import(pathToFileURL(file).href);
}

/** The shell's `config.json` for a resolved scraper configuration. */
export function shellConfigFor(config, extra = {}) {
  const shell = { contentUrl: "content/", feedName: config.feedName, actions: config.actions, utmSource: config.utmSource };
  if (config.subscribeUrl) shell.subscribeUrl = config.subscribeUrl;
  return { ...shell, ...extra };
}

export function writeFiles(dir, files) {
  for (const [path, data] of files) {
    const file = join(dir, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, data);
  }
}

/**
 * Build the shell into `outDir` (emptied first). `shellConfig` is the object written
 * to `config.json` there; the Vite build reads the same file for the manifest name.
 * `base` defaults to a relative base, which works under any path. `scratchDir` holds
 * the config the build reads.
 */
export function buildShell({ outDir, shellConfig, scratchDir, base = "./", quiet = false, env = process.env }) {
  const configPath = join(scratchDir, "config.json");
  const text = `${JSON.stringify(shellConfig, null, 2)}\n`;
  mkdirSync(scratchDir, { recursive: true });
  writeFileSync(configPath, text);
  return new Promise((resolve, reject) => {
    // Vite's own entry file, found from the shell package: no `npx`, so nothing is
    // ever fetched from the registry.
    const vite = join(dirname(createRequire(join(shellDir, "package.json")).resolve("vite/package.json")), "bin", "vite.js");
    const child = spawn(process.execPath, [vite, "build", "--outDir", outDir, "--emptyOutDir", "--logLevel", "warn"], {
      cwd: shellDir,
      stdio: quiet ? ["ignore", "ignore", "inherit"] : "inherit",
      env: { ...env, SUBSTACKER_BASE: base, SUBSTACKER_SHELL_CONFIG: configPath },
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) return reject(new Error(`shell build failed (exit ${code})`));
      writeFileSync(join(outDir, "config.json"), text);
      resolve();
    });
  });
}

/** Files under `dir`, relative and sorted. */
export function listFiles(dir) {
  if (!existsSync(dir)) return [];
  const walk = (d) => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
  return walk(dir).map((f) => relative(dir, f).split("\\").join("/")).sort();
}

export function dirSize(dir) {
  return listFiles(dir).reduce((sum, f) => sum + statSync(join(dir, f)).size, 0);
}

export function readIfExists(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

/** Size of the assembled site against the Pages budget. */
export function siteSize(dir) {
  const bytes = dirSize(dir);
  const mb = (bytes / (1024 * 1024)).toFixed(1);
  const summary = `Site size: ${mb} MB in ${listFiles(dir).length} files (limit ${SITE_LIMIT_BYTES / (1024 * 1024)} MB)`;
  return { bytes, summary, ok: bytes <= SITE_LIMIT_BYTES };
}
