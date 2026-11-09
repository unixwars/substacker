import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { diskBackup, writeChanges } from "./backup.js";
import { build } from "./build.js";
import { loadConfig } from "./config.js";
import { createPinnedFetch } from "./net.js";
import { scrape } from "./scrape.js";
import { VERSION } from "./version.js";

function option(args: string[], name: string, fallback: string): string {
  const i = args.indexOf(name);
  const value = i >= 0 ? args[i + 1] : undefined;
  return value ?? fallback;
}

const readIfExists = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : undefined);

export async function runScrape(args: string[], env: Record<string, string | undefined>): Promise<number> {
  if (args.includes("--version")) {
    console.log(`substacker-scrape ${VERSION}`);
    return 0;
  }
  if (args.includes("--help")) {
    console.log("Usage: substacker-scrape [--backup <dir>] [--version]\nReads the feed and writes raw items and images into <dir> (default: content).");
    return 0;
  }
  const dir = option(args, "--backup", "content");
  // Only the test suites and the publish dry run set this (they serve a feed from loopback).
  // It is an environment variable, not part of the configuration document.
  const allowPrivate = env["SUBSTACKER_UNSAFE_ALLOW_PRIVATE_NETWORK"] === "1";
  const config = loadConfig(env, readIfExists, { allowPrivate });
  const changes = await scrape(config, { fetch: createPinnedFetch({ allowPrivate }), allowPrivate, backup: diskBackup(dir), env, log: (m) => console.warn(m) });
  writeChanges(dir, changes);
  const raws = changes.filter((c) => c.kind === "raw").length;
  console.log(`${raws} raw item(s) and ${changes.length - raws} image(s) written to ${dir}`);
  return 0;
}

export function runBuild(args: string[], env: Record<string, string | undefined>): number {
  if (args.includes("--version")) {
    console.log(`substacker-build ${VERSION}`);
    return 0;
  }
  if (args.includes("--help")) {
    console.log("Usage: substacker-build [--backup <dir>] [--out <dir>] [--version]\nDerives the served files from the backup into <out> (default: site/content).");
    return 0;
  }
  const backup = option(args, "--backup", "content");
  const out = option(args, "--out", join("site", "content"));
  const { files, warnings } = build(loadConfig(env, readIfExists), backup);
  for (const [path, data] of files) {
    const file = join(out, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, data);
  }
  for (const w of warnings) console.warn(`warning: ${w}`);
  console.log(`${files.size} file(s) written to ${out}`);
  return 0;
}

export function fail(e: unknown): never {
  console.error(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
  process.exit(1);
}
