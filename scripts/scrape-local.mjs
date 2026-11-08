// The scrape that runs on a machine you control (a laptop, or a small server with a
// timer): GitHub's runners and the relay are refused by the feed, so the backup is made
// here and pushed to the `content` branch, and GitHub Actions only builds and deploys.
//
//   node scripts/scrape-local.mjs [--init] [--no-dispatch] [--dry-run]
//
//   --init         create the orphan `content` branch (one empty commit) on origin, if missing
//   --no-dispatch  push, but do not ask GitHub to run the publish workflow
//   --dry-run      scrape and commit in the local worktree; no push, no dispatch
//
// Run from the repository (it works on the repository containing the current directory),
// after `npm run build`. The worktree of `content` is `./content`. Exit codes: 0 done
// (including nothing new), 1 failure, 2 usage or another run in progress.
//
// Never forces a push, never resets or discards local changes, never deletes. A push to
// `content` cannot start the workflow (the branch holds data, not workflow files), so a
// new commit is followed by a `workflow_dispatch` call when a token is set; if that fails
// it is only a warning, since the daily schedule rebuilds from whatever is on `content`.
//
// Environment: SUBSTACKER_CONFIG (or substacker.config.local.json), and optionally
// SUBSTACKER_DISPATCH_TOKEN (or GITHUB_TOKEN / GH_TOKEN), SUBSTACKER_REPO=owner/repo
// (default: from the origin remote). SUBSTACKER_API_URL is for the tests only.
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { readIfExists, scraperDist, scraperModule } from "./site.mjs";

const execFileP = promisify(execFile);

class Failure extends Error {
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}

export async function main(argv, env = process.env) {
  const known = new Set(["--init", "--no-dispatch", "--dry-run", "--help"]);
  const bad = argv.find((a) => !known.has(a));
  if (bad || argv.includes("--help")) {
    const text = "Usage: node scripts/scrape-local.mjs [--init] [--no-dispatch] [--dry-run]";
    if (bad) throw new Failure(`Unknown option ${bad}. ${text}`, 2);
    console.log(text);
    return 0;
  }
  const init = argv.includes("--init");
  const dryRun = argv.includes("--dry-run");
  const noDispatch = argv.includes("--no-dispatch");
  if (init && dryRun) throw new Failure("--init pushes a branch; it cannot be combined with --dry-run.", 2);

  const local = await scraperModule("local");
  const git = async (cwd, ...args) => (await execFileP("git", args, { cwd, env, maxBuffer: 64 * 1024 * 1024 })).stdout;
  const gitTry = async (cwd, ...args) => {
    try {
      return { ok: true, out: await git(cwd, ...args), err: "" };
    } catch (e) {
      return { ok: false, out: e.stdout ?? "", err: `${e.stderr ?? ""}${e.stdout ?? ""}`.trim(), code: e.code };
    }
  };

  // The repository of the current directory.
  const top = await gitTry(process.cwd(), "rev-parse", "--show-toplevel");
  if (!top.ok) throw new Failure("Run this inside the repository (a git checkout).", 2);
  const repo = realpathSync(top.out.trim());
  process.chdir(repo); // the configuration file is looked up from here
  const wt = join(repo, "content");

  if (!existsSync(join(scraperDist, "bin", "scrape.js"))) throw new Failure("The scraper is not built. Run: npm run build");

  // Fail early on a missing or invalid configuration, with the loader's own message.
  const { loadConfig } = await scraperModule("config");
  try {
    loadConfig(env, readIfExists, { allowPrivate: env["SUBSTACKER_UNSAFE_ALLOW_PRIVATE_NETWORK"] === "1" });
  } catch (e) {
    throw new Failure(e instanceof Error ? e.message : String(e));
  }

  const unlock = acquireLock(repo, (await git(repo, "rev-parse", "--absolute-git-dir")).trim(), local);
  try {
    return await withLock();
  } finally {
    unlock();
  }

  async function withLock() {
    // Commits need an identity; check now, before any work is left half-done.
    const name = (await gitTry(repo, "config", "user.name")).out.trim();
    const email = (await gitTry(repo, "config", "user.email")).out.trim();
    if (!name || !email) {
      throw new Failure('No git identity. Set one for this repository: git config user.name "Your Name" && git config user.email "you@example.com"');
    }

    const remote = await gitTry(repo, "ls-remote", "--exit-code", "--heads", "origin", "content");
    if (!remote.ok && remote.code !== 2) throw new Failure(`Cannot reach origin: ${remote.err}`);
    if (!remote.ok) {
      if (!init) throw new Failure("origin has no `content` branch. Create it once with: npm run scrape:local -- --init");
      const tree = (await git(repo, "hash-object", "-t", "tree", "/dev/null")).trim();
      const commit = (await git(repo, "commit-tree", tree, "-m", "Create the content branch")).trim();
      // A new ref: a plain push, which git refuses to turn into anything but a creation.
      const pushed = await gitTry(repo, "push", "origin", `${commit}:refs/heads/content`);
      if (!pushed.ok) throw new Failure(`Could not create the content branch: ${pushed.err}`);
      console.log("Created the `content` branch on origin.");
    } else if (init) {
      console.log("origin already has a `content` branch; --init has nothing to do.");
    }
    const fetched = await gitTry(repo, "fetch", "origin", "content");
    if (!fetched.ok) throw new Failure(`git fetch origin content failed: ${fetched.err}`);

    await prepareWorktree();

    // Scrape into the worktree.
    const scrape = await run("node", [join(scraperDist, "bin", "scrape.js"), "--backup", wt], { cwd: repo, env });
    if (scrape.stderr.trim()) process.stderr.write(scrape.stderr);

    mkdirSync(join(wt, "raw"), { recursive: true });
    mkdirSync(join(wt, "images"), { recursive: true });
    await git(wt, "add", "-A", "raw", "images");
    const staged = (await git(wt, "diff", "--cached", "--name-only")).split("\n").filter(Boolean).sort();
    const counts = local.summarizeStaged(staged);
    if (staged.length > 0) await git(wt, "commit", "-q", "-m", local.backupMessage(counts));

    const unpushed = Number((await git(wt, "rev-list", "--count", "origin/content..HEAD")).trim());
    if (unpushed === 0) {
      console.log("scrape:local: nothing new; content is up to date.");
      return 0;
    }
    const what = staged.length > 0 ? `${local.backupMessage(counts)}` : `${unpushed} earlier commit(s) not yet pushed`;
    if (dryRun) {
      console.log(`scrape:local (dry run): committed locally, not pushed: ${what}.`);
      return 0;
    }

    await push();
    if (noDispatch) {
      console.log(`scrape:local: pushed (${what}); dispatch skipped (--no-dispatch).`);
      return 0;
    }
    const outcome = await dispatch();
    console.log(`scrape:local: pushed (${what}); ${outcome}`);
    return 0;
  }

  async function prepareWorktree() {
    const isEmptyDir = existsSync(wt) && readdirSync(wt).length === 0;
    if (!existsSync(wt) || isEmptyDir) {
      const hasBranch = (await gitTry(repo, "rev-parse", "--verify", "--quiet", "refs/heads/content")).ok;
      const args = hasBranch ? ["worktree", "add", "content", "content"] : ["worktree", "add", "--track", "-b", "content", "content", "origin/content"];
      const added = await gitTry(repo, ...args);
      if (!added.ok) throw new Failure(`Could not create the worktree ./content: ${added.err}`);
      if (hasBranch) await fastForward();
      return;
    }
    const inner = await gitTry(wt, "rev-parse", "--show-toplevel");
    const branch = (await gitTry(wt, "rev-parse", "--abbrev-ref", "HEAD")).out.trim();
    if (!inner.ok || realpathSync(inner.out.trim()) !== realpathSync(wt) || branch !== "content") {
      throw new Failure("./content exists but is not a worktree of the `content` branch. Move it away or remove it, then run again.");
    }
    const status = (await git(wt, "status", "--porcelain")).trim();
    if (status) {
      throw new Failure(
        `./content has uncommitted changes (nothing was touched):\n${status}\nCommit or remove them yourself (git -C content status), then run again.`,
      );
    }
    await fastForward();
  }

  async function fastForward() {
    const merged = await gitTry(wt, "merge", "--ff-only", "origin/content");
    if (!merged.ok) {
      throw new Failure(`./content cannot be fast-forwarded to origin/content (it has commits origin does not):\n${merged.err}\nResolve it by hand; nothing was changed.`);
    }
  }

  async function push() {
    const attempt = () => gitTry(wt, "push", "origin", "HEAD:refs/heads/content");
    let result = await attempt();
    if (result.ok) return;
    // Someone else pushed first: fetch, bring their commits in (a merge, history is never
    // rewritten) and try once more.
    const fetched = await gitTry(wt, "fetch", "origin", "content");
    if (fetched.ok) {
      const merged = await gitTry(wt, "merge", "--no-edit", "origin/content");
      if (!merged.ok) {
        await gitTry(wt, "merge", "--abort");
        throw new Failure(`The push was rejected and origin/content could not be merged in:\n${merged.err}\nNothing was forced. Resolve it by hand in ./content.`);
      }
      result = await attempt();
      if (result.ok) return;
    }
    throw new Failure(`git push origin content failed (not forced):\n${result.err}`);
  }

  async function dispatch() {
    const token = local.dispatchToken(env);
    if (!token) return "no dispatch token set, so the deploy waits for the daily schedule.";
    const remoteUrl = (await gitTry(repo, "config", "--get", "remote.origin.url")).out;
    const slug = env["SUBSTACKER_REPO"] ? local.parseRepoSlug(env["SUBSTACKER_REPO"], { bare: true }) : local.parseRepoSlug(remoteUrl);
    if (!slug) {
      console.warn("warning: cannot tell the GitHub repository from the origin remote; set SUBSTACKER_REPO=owner/repo. The daily schedule will deploy.");
      return "deploy not requested.";
    }
    try {
      const { url, init: req } = local.dispatchRequest({ slug, token, apiBase: env["SUBSTACKER_API_URL"] || "https://api.github.com" });
      const res = await fetch(url, { ...req, signal: AbortSignal.timeout(15_000) });
      if (res.status === 204) return "deploy requested.";
      console.warn(`warning: GitHub answered ${res.status} to the deploy request; the daily schedule will deploy.`);
    } catch (e) {
      // The message never carries the token (it is only in the request headers).
      console.warn(`warning: the deploy request failed (${e instanceof Error ? e.message : String(e)}); the daily schedule will deploy.`);
    }
    return "deploy not requested.";
  }
}

/** Take the lock, or throw (exit 2) if a live run holds it. Returns the release function. */
function acquireLock(repo, gitDir, local) {
  const file = join(gitDir, "substacker-scrape.lock");
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return e.code === "EPERM";
    }
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(file, JSON.stringify({ pid: process.pid, startedAt: Date.now() }), { flag: "wx" });
      return () => rmSync(file, { force: true });
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      const text = existsSync(file) ? readFileSync(file, "utf8") : "";
      const lock = local.parseLock(text);
      if (!local.lockIsStale(lock, { now: Date.now(), alive })) {
        throw new Failure(`Another scrape:local run is in progress (pid ${lock?.pid}). If it is not, remove ${file}.`, 2);
      }
      rmSync(file, { force: true });
    }
  }
  throw new Failure(`Could not take the lock ${file}.`, 2);
}

function run(cmd, args, { cwd, env }) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) return resolvePromise({ stdout, stderr });
      reject(new Failure(`The scrape failed (exit ${code}):\n${(stderr || stdout).trim()}`));
    });
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(e instanceof Failure ? e.code : 1);
    },
  );
}
