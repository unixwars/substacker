// The publish steps, in one place. `.github/workflows/publish.yml` and
// `scripts/publish-dry-run.mjs` both call these, so the workflow and its dry run cannot
// drift apart. The scraper CLIs are run by path from the workspace build, never through
// `npx`: before `dist` exists npm does not link workspace bins, and `npx` would fall
// through to the registry and run a stranger's package with the write token.
//
//   node scripts/publish.mjs scrape  [--backup content]
//   node scripts/publish.mjs commit  [--backup content] [--push]
//   node scripts/publish.mjs shell   [--out site]
//   node scripts/publish.mjs content [--backup content] [--out site/content]
//   node scripts/publish.mjs site    [--backup content] [--out site]   (shell, then content)
//   node scripts/publish.mjs size    [--out site]                      (fails above the budget)
//
// Needs `npm run build` first (the scraper's `dist`).
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildShell, readIfExists, root, scraperDist, scraperModule, shellConfigFor, siteSize } from "./site.mjs";

const BOT = ["-c", "user.name=github-actions[bot]", "-c", "user.email=41898282+github-actions[bot]@users.noreply.github.com"];

/** Run a command; with `echo` its output is also shown live. Rejects on a non-zero exit. */
function run(cmd, args, { cwd = root, env = process.env, echo = false } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; if (echo) process.stdout.write(d); });
    child.stderr.on("data", (d) => { stderr += d; if (echo) process.stderr.write(d); });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) return resolvePromise({ stdout, stderr });
      reject(new Error(`${cmd} ${args.join(" ")} failed (exit ${code})\n${stderr || stdout}`.trim()));
    });
  });
}

/** Fetch the feed and store new and edited raw items and missing images in `backup`. */
export function scrapeStep({ backup, env = process.env, echo = false }) {
  return run("node", [join(scraperDist, "bin", "scrape.js"), "--backup", backup], { env, echo });
}

/**
 * Stage `raw` and `images` in the backup checkout and commit them if anything changed.
 * Returns the committed (or, with nothing to commit, an empty list of) file names.
 */
export async function commitBackupStep({ backup, push = false, echo = false }) {
  const git = (...a) => run("git", ["-C", backup, ...BOT, ...a], { echo });
  // `git add` exits 128 for a pathspec that matches nothing, e.g. a feed with no images.
  mkdirSync(join(backup, "raw"), { recursive: true });
  mkdirSync(join(backup, "images"), { recursive: true });
  await git("add", "-A", "raw", "images");
  const staged = (await git("diff", "--cached", "--name-only")).stdout.split("\n").filter(Boolean).sort();
  if (staged.length === 0) return [];
  await git("commit", "-q", "-m", "Back up new and edited posts");
  if (push) await git("push", "origin", "HEAD:content");
  return staged;
}

/** Build the shell into `out` with `config.json` written from the resolved configuration. */
export async function shellStep({ out, env = process.env }) {
  const { loadConfig } = await scraperModule("config");
  const config = loadConfig(env, readIfExists);
  const scratch = mkdtempSync(join(tmpdir(), "substacker-shell-"));
  try {
    await buildShell({ outDir: out, shellConfig: shellConfigFor(config), scratchDir: scratch, env });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Derive the served files from the backup into `out`. */
export function contentStep({ backup, out, env = process.env, echo = false }) {
  return run("node", [join(scraperDist, "bin", "build.js"), "--backup", backup, "--out", out], { env, echo });
}

/** One Pages site: the shell at the root, the served content under `content/`. */
export async function siteStep({ backup, out, env = process.env, echo = false }) {
  await shellStep({ out, env });
  return contentStep({ backup, out: join(out, "content"), env, echo });
}

/** Report the site size; `ok` is false above the Pages budget. */
export function sizeStep({ out }) {
  const result = siteSize(out);
  if (process.env["GITHUB_STEP_SUMMARY"]) appendFileSync(process.env["GITHUB_STEP_SUMMARY"], `${result.summary}\n`);
  return result;
}

async function main(argv) {
  const [step, ...rest] = argv;
  const opt = (name, fallback) => (rest.includes(name) ? rest[rest.indexOf(name) + 1] : fallback);
  const backup = resolve(opt("--backup", "content"));
  switch (step) {
    case "scrape":
      return void (await scrapeStep({ backup, echo: true }));
    case "commit":
    {
      const files = await commitBackupStep({ backup, push: rest.includes("--push"), echo: true });
      console.log(files.length === 0 ? "Nothing new to back up." : `Backed up ${files.length} file(s).`);
      return;
    }
    case "shell":
      return void (await shellStep({ out: resolve(opt("--out", "site")) }));
    case "content":
      return void (await contentStep({ backup, out: resolve(opt("--out", join("site", "content"))), echo: true }));
    case "site":
      return void (await siteStep({ backup, out: resolve(opt("--out", "site")), echo: true }));
    case "size": {
      const result = sizeStep({ out: resolve(opt("--out", "site")) });
      console.log(result.summary);
      if (!result.ok) {
        console.error("The site is over the limit; GitHub Pages allows about 1 GB. Failing.");
        process.exitCode = 1;
      }
      return;
    }
    default:
      console.error("Usage: node scripts/publish.mjs <scrape|commit|shell|content|site|size> [options]");
      process.exitCode = 2;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
