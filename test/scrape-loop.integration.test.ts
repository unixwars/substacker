import type { ChildProcess } from "node:child_process";
import { execFile, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";

// `scripts/scrape-loop.mjs` and `scripts/healthcheck.mjs` against a bare repository
// standing in for GitHub and a fixture feed on loopback. Nothing leaves the machine.

const root = join(import.meta.dirname, "..");
const loop = join(root, "scripts", "scrape-loop.mjs");
const healthcheck = join(root, "scripts", "healthcheck.mjs");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const fixture = readFileSync(join(root, "packages", "scraper", "test", "fixtures", "feed.xml"), "utf8");
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64");

let feedServer: Server;
let feedOrigin = "";
let top = "";
let counter = 0;
const running: ChildProcess[] = [];

beforeAll(async () => {
  execFileSync(npm, ["run", "build", "-w", "substacker-core", "-w", "substacker-scraper"], { cwd: root, stdio: "ignore" });
  top = mkdtempSync(join(tmpdir(), "substacker-scrape-loop-"));
  feedServer = createServer((req, res) => {
    if (req.url === "/feed") {
      const body = ["https://substackcdn.com", "https://images.unsplash.com", "https://substack-post-media.s3.amazonaws.com"].reduce((s, h) => s.replaceAll(h, feedOrigin), fixture);
      res.writeHead(200, { "content-type": "application/rss+xml" }).end(body);
    } else if (req.url === "/hang") {
      // Never answers: a scrape stuck in the network.
    } else {
      res.writeHead(200, { "content-type": "image/png" }).end(PNG);
    }
  });
  await new Promise<void>((r) => feedServer.listen(0, "127.0.0.1", r));
  feedOrigin = `http://127.0.0.1:${(feedServer.address() as AddressInfo).port}`;
});
afterEach(() => {
  for (const c of running.splice(0)) c.kill("SIGKILL");
});
afterAll(() => {
  feedServer.closeAllConnections();
  feedServer.close();
  rmSync(top, { recursive: true, force: true });
});

const GIT_ENV = { GIT_AUTHOR_NAME: "Seed", GIT_AUTHOR_EMAIL: "seed@example.com", GIT_COMMITTER_NAME: "Seed", GIT_COMMITTER_EMAIL: "seed@example.com" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...GIT_ENV }, stdio: ["ignore", "pipe", "pipe"] }).trim();

interface Scenario {
  dir: string;
  bare: string;
  data: string;
}

function scenario(withContent = true): Scenario {
  const dir = join(top, `s${++counter}`);
  const bare = join(dir, "origin.git");
  const seed = join(dir, "seed");
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "--bare", "-b", "main", bare);
  git(dir, "init", "-q", "-b", "main", seed);
  git(seed, "remote", "add", "origin", bare);
  if (withContent) {
    const empty = git(seed, "hash-object", "-t", "tree", "/dev/null");
    git(seed, "push", "-q", "origin", `${git(seed, "commit-tree", empty, "-m", "Create the content branch")}:refs/heads/content`);
  }
  return { dir, bare, data: join(dir, "data") };
}

function envFor(s: Scenario, extra: Record<string, string> = {}, feed = "/feed"): NodeJS.ProcessEnv {
  const config = { feedUrl: `${feedOrigin}${feed}`, feedName: "Example Newsletter", actions: [], utmSource: "substacker", hidden: [] };
  return {
    ...process.env,
    GITHUB_TOKEN: undefined,
    GH_TOKEN: undefined,
    SUBSTACKER_DISPATCH_TOKEN: undefined,
    SUBSTACKER_CONFIG: JSON.stringify(config),
    SUBSTACKER_UNSAFE_ALLOW_PRIVATE_NETWORK: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    HOME: top,
    SUBSTACKER_CONTENT_REMOTE: s.bare,
    SUBSTACKER_GIT_NAME: "Container Bot",
    SUBSTACKER_GIT_EMAIL: "bot@example.com",
    SUBSTACKER_DATA_DIR: s.data,
    SUBSTACKER_START_MARKER: join(s.dir, "started"),
    ...extra,
  };
}

interface Result {
  code: number;
  out: string;
  err: string;
}
const runNode = (script: string, args: string[], env: NodeJS.ProcessEnv) =>
  new Promise<Result>((resolve) => {
    execFile("node", [script, ...args], { cwd: top, env }, (e, out, err) => resolve({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, out, err }));
  });

/** A running loop with its output collected, and a way to wait for a line of it. */
function startLoop(env: NodeJS.ProcessEnv, args: string[] = []) {
  const child = spawn("node", [loop, ...args], { cwd: top, env, stdio: ["ignore", "pipe", "pipe"] });
  running.push(child);
  let output = "";
  child.stdout?.on("data", (d: Buffer) => (output += d.toString()));
  child.stderr?.on("data", (d: Buffer) => (output += d.toString()));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) => child.on("exit", (code, signal) => r({ code, signal })));
  const waitFor = async (re: RegExp, ms = 30_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (re.test(output)) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`Timed out waiting for ${re}; output so far:\n${output}`);
  };
  return { child, exited, waitFor, output: () => output };
}

const originFiles = (s: Scenario) => git(s.bare, "ls-tree", "-r", "--name-only", "content").split("\n").filter(Boolean);
const count = (text: string, re: RegExp) => (text.match(re) ?? []).length;

it("--once scrapes now, pushes, records last-success and exits with the script's code", async () => {
  const s = scenario();
  const r = await runNode(loop, ["--once", "--no-dispatch"], envFor(s));
  expect(r.err).toBe("");
  expect(r.code).toBe(0);
  expect(r.out).toMatch(/scrape:local: pushed/);
  expect(originFiles(s)).toEqual(expect.arrayContaining(["raw/hello-world.xml"]));
  const stamp = readFileSync(join(s.data, "last-success"), "utf8").trim();
  expect(new Date(stamp).toISOString()).toBe(stamp);
  expect(Date.now() - Date.parse(stamp)).toBeLessThan(60_000);
  // The health check agrees.
  expect((await runNode(healthcheck, [], envFor(s))).code).toBe(0);
  // A second run changes nothing and succeeds.
  const again = await runNode(loop, ["--once"], envFor(s));
  expect(again.code).toBe(0);
  expect(again.out).toContain("nothing new");
});

it("--once passes --init through, and exits non-zero without touching last-success on failure", async () => {
  const s = scenario(false);
  const failed = await runNode(loop, ["--once"], envFor(s));
  expect(failed.code).toBe(1);
  expect(existsSync(join(s.data, "last-success"))).toBe(false);
  const init = await runNode(loop, ["--once", "--init", "--no-dispatch"], envFor(s));
  expect(init.code).toBe(0);
  expect(init.out).toContain("Created the `content` branch");
  expect(existsSync(join(s.data, "last-success"))).toBe(true);
});

it("--once --dry-run pushes nothing and records no success", async () => {
  const s = scenario();
  const r = await runNode(loop, ["--once", "--dry-run"], envFor(s));
  expect(r.code).toBe(0);
  expect(r.out).toContain("dry run");
  expect(existsSync(join(s.data, "last-success"))).toBe(false);
  expect(originFiles(s)).toEqual([]);
});

it("rejects an unknown argument and a bad schedule", async () => {
  const s = scenario();
  expect((await runNode(loop, ["--nope"], envFor(s))).code).toBe(2);
  const bad = await runNode(loop, [], envFor(s, { SUBSTACKER_SCHEDULE_UTC: "25:00" }));
  expect(bad.code).toBe(2);
  expect(bad.err).toContain("SUBSTACKER_SCHEDULE_UTC");
});

it("the daily loop runs the scrape when the time comes, and keeps going", async () => {
  const s = scenario();
  const l = startLoop(envFor(s, { SUBSTACKER_TEST_NEXT_RUN_MS: "400", SUBSTACKER_JITTER_MINUTES: "0", SUBSTACKER_DISPATCH_TOKEN: "loop-secret-token-1", SUBSTACKER_API_URL: "http://127.0.0.1:9" }));
  await l.waitFor(/scrape finished/);
  expect(originFiles(s).length).toBeGreaterThan(0);
  expect(existsSync(join(s.data, "last-success"))).toBe(true);
  await l.waitFor(/scrape finished[\s\S]*next scrape at[\s\S]*scrape finished/);
  expect(l.child.exitCode).toBeNull();
  l.child.kill("SIGTERM");
  expect((await l.exited).code).toBe(0);
  expect(l.output()).not.toContain("loop-secret-token-1");
  expect(l.output()).not.toMatch(/feedUrl|Example Newsletter/);
});

it("a failing run is retried, then waits for the next day; the loop does not exit", async () => {
  const s = scenario();
  const l = startLoop(envFor(s, { SUBSTACKER_CONTENT_REMOTE: join(s.dir, "missing.git"), SUBSTACKER_RUN_ON_START: "1", SUBSTACKER_RETRY_DELAYS_MS: "50,50,50" }));
  await l.waitFor(/giving up until the next scheduled run/);
  expect(count(l.output(), /scrape starting/g)).toBe(4);
  expect(count(l.output(), /scrape failed/g)).toBe(3 + 1);
  await l.waitFor(/giving up[\s\S]*next scrape at/);
  expect(l.child.exitCode).toBeNull();
  expect(existsSync(join(s.data, "last-success"))).toBe(false);
  const stop = Date.now();
  l.child.kill("SIGTERM");
  expect((await l.exited).code).toBe(0);
  expect(Date.now() - stop).toBeLessThan(3_000);
});

it("a run that fails and then succeeds records the success", async () => {
  const s = scenario(false); // no content branch yet: fails
  const l = startLoop(envFor(s, { SUBSTACKER_RUN_ON_START: "1", SUBSTACKER_RETRY_DELAYS_MS: "1500" }));
  await l.waitFor(/retrying in/);
  const seed = join(s.dir, "seed");
  const empty = git(seed, "hash-object", "-t", "tree", "/dev/null");
  git(seed, "push", "-q", "origin", `${git(seed, "commit-tree", empty, "-m", "Create the content branch")}:refs/heads/content`);
  await l.waitFor(/scrape finished/);
  expect(existsSync(join(s.data, "last-success"))).toBe(true);
  l.child.kill("SIGTERM");
  await l.exited;
});

it("SIGTERM ends the loop promptly in the middle of the sleep", async () => {
  const s = scenario();
  const l = startLoop(envFor(s));
  await l.waitFor(/next scrape at/);
  const stop = Date.now();
  l.child.kill("SIGTERM");
  const { code } = await l.exited;
  expect(code).toBe(0);
  expect(Date.now() - stop).toBeLessThan(3_000);
  expect(l.output()).toContain("SIGTERM received");
});

it("SIGTERM stops a scrape that is running and ends the loop promptly", async () => {
  const s = scenario();
  const l = startLoop(envFor(s, { SUBSTACKER_RUN_ON_START: "1" }, "/hang"));
  await l.waitFor(/Cloned the `content` branch/);
  await new Promise((r) => setTimeout(r, 500)); // the scraper is now waiting on the feed
  const stop = Date.now();
  l.child.kill("SIGINT");
  const { code } = await l.exited;
  expect(code).toBe(0);
  expect(Date.now() - stop).toBeLessThan(5_000);
  expect(existsSync(join(s.data, "last-success"))).toBe(false);
  expect(existsSync(join(s.data, "content", ".git", "substacker-scrape.lock"))).toBe(false);
});

it("healthcheck: fresh, recent, old and missing states", async () => {
  const s = scenario();
  mkdirSync(s.data, { recursive: true });
  const env = envFor(s);
  // A fresh container (no marker, no success) is healthy and starts the clock.
  const fresh = await runNode(healthcheck, [], env);
  expect(fresh.code).toBe(0);
  expect(existsSync(join(s.dir, "started"))).toBe(true);
  // Started long ago, no success: unhealthy, one line.
  writeFileSync(join(s.dir, "started"), new Date(Date.now() - 40 * 3_600_000).toISOString());
  const stale = await runNode(healthcheck, [], env);
  expect(stale.code).toBe(1);
  expect(stale.out.trim().split("\n")).toHaveLength(1);
  expect(stale.out).toMatch(/no successful scrape/);
  // A recent success makes it healthy again; an old one does not.
  writeFileSync(join(s.data, "last-success"), new Date(Date.now() - 2 * 3_600_000).toISOString());
  expect((await runNode(healthcheck, [], env)).code).toBe(0);
  writeFileSync(join(s.data, "last-success"), new Date(Date.now() - 37 * 3_600_000).toISOString());
  const old = await runNode(healthcheck, [], env);
  expect(old.code).toBe(1);
  expect(old.out).toMatch(/37 h ago/);
});
