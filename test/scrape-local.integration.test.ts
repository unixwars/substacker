import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, Server } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";

// `scripts/scrape-local.mjs` against a bare repository standing in for GitHub, a fixture
// feed served from loopback and a fake GitHub API. Nothing leaves the machine.

const root = join(import.meta.dirname, "..");
const script = join(root, "scripts", "scrape-local.mjs");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64");
const fixture = readFileSync(join(root, "packages", "scraper", "test", "fixtures", "feed.xml"), "utf8");
const NO_IMAGES = `<?xml version="1.0"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>T</title>
<item><title>Plain</title><link>https://example.substack.com/p/plain</link><pubDate>Mon, 02 Mar 2026 10:00:00 GMT</pubDate><content:encoded><![CDATA[<p>No images here.</p>]]></content:encoded></item>
</channel></rss>`;

interface ApiCall {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingMessage["headers"];
  body: string;
}

let feedServer: Server;
let apiServer: Server;
let feedOrigin = "";
let apiOrigin = "";
let apiStatus = 204;
const apiCalls: ApiCall[] = [];
let top = "";

const listen = (server: Server) => new Promise<number>((r) => server.listen(0, "127.0.0.1", () => r((server.address() as AddressInfo).port)));

beforeAll(async () => {
  execFileSync(npm, ["run", "build", "-w", "substacker-core", "-w", "substacker-scraper"], { cwd: root, stdio: "ignore" });
  top = mkdtempSync(join(tmpdir(), "substacker-scrape-local-"));
  feedServer = createServer((req, res) => {
    if (req.url === "/feed") {
      const body = ["https://substackcdn.com", "https://images.unsplash.com", "https://substack-post-media.s3.amazonaws.com"].reduce((s, h) => s.replaceAll(h, feedOrigin), fixture);
      res.writeHead(200, { "content-type": "application/rss+xml" }).end(body);
    } else if (req.url === "/noimg") {
      res.writeHead(200, { "content-type": "application/rss+xml" }).end(NO_IMAGES);
    } else {
      res.writeHead(200, { "content-type": "image/png" }).end(PNG);
    }
  });
  feedOrigin = `http://127.0.0.1:${await listen(feedServer)}`;
  apiServer = createServer((req, res) => {
    let body = "";
    req.on("data", (d: Buffer) => (body += d.toString()));
    req.on("end", () => {
      apiCalls.push({ method: req.method, url: req.url, headers: req.headers, body });
      res.writeHead(apiStatus, { "content-type": "application/json" }).end(apiStatus === 204 ? undefined : '{"message":"nope"}');
    });
  });
  apiOrigin = `http://127.0.0.1:${await listen(apiServer)}`;
});
afterAll(() => {
  feedServer.close();
  apiServer.close();
  rmSync(top, { recursive: true, force: true });
});

const GIT_ENV = {
  GIT_AUTHOR_NAME: "Seed",
  GIT_AUTHOR_EMAIL: "seed@example.com",
  GIT_COMMITTER_NAME: "Seed",
  GIT_COMMITTER_EMAIL: "seed@example.com",
};
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...GIT_ENV }, stdio: ["ignore", "pipe", "pipe"] }).trim();

let counter = 0;
interface Scenario {
  bare: string;
  clone: string;
}

/** A bare `origin` with `main` and, unless `withContent` is false, an empty orphan `content`; and a clone of it with an identity. */
function scenario(withContent = true): Scenario {
  const dir = join(top, `s${++counter}`);
  const bare = join(dir, "origin.git");
  const seed = join(dir, "seed");
  const clone = join(dir, "clone");
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "--bare", "-b", "main", bare);
  git(bare, "config", "receive.denyNonFastForwards", "true");
  git(bare, "config", "receive.denyDeletes", "true");
  git(dir, "init", "-q", "-b", "main", seed);
  writeFileSync(join(seed, "README"), "main\n");
  git(seed, "add", "README");
  git(seed, "commit", "-q", "-m", "main");
  git(seed, "remote", "add", "origin", bare);
  git(seed, "push", "-q", "origin", "main");
  if (withContent) {
    const empty = git(seed, "hash-object", "-t", "tree", "/dev/null");
    const c = git(seed, "commit-tree", empty, "-m", "Create the content branch");
    git(seed, "push", "-q", "origin", `${c}:refs/heads/content`);
  }
  git(dir, "clone", "-q", bare, clone);
  git(clone, "config", "user.name", "Owner");
  git(clone, "config", "user.email", "owner@example.com");
  return { bare, clone };
}

interface Result {
  code: number;
  out: string;
  err: string;
}

function runScript(s: Scenario, args: string[] = [], extra: Record<string, string> = {}, feed = "/feed"): Promise<Result> {
  const config = { feedUrl: `${feedOrigin}${feed}`, feedName: "Example Newsletter", actions: [], utmSource: "substacker", hidden: [] };
  const env: Record<string, string | undefined> = {
    ...process.env,
    GITHUB_TOKEN: undefined,
    GH_TOKEN: undefined,
    SUBSTACKER_DISPATCH_TOKEN: undefined,
    SUBSTACKER_CONFIG: JSON.stringify(config),
    SUBSTACKER_UNSAFE_ALLOW_PRIVATE_NETWORK: "1",
    ...extra,
  };
  return new Promise((resolve) => {
    execFile("node", [script, ...args], { cwd: s.clone, env: env as NodeJS.ProcessEnv }, (e, out, err) => {
      resolve({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, out, err });
    });
  });
}

const dispatchEnv = (token = "test-token-123") => ({ SUBSTACKER_DISPATCH_TOKEN: token, SUBSTACKER_REPO: "example-owner/example-repo", SUBSTACKER_API_URL: apiOrigin });
const originFiles = (s: Scenario) => git(s.bare, "ls-tree", "-r", "--name-only", "content").split("\n").filter(Boolean);
const tip = (s: Scenario) => git(s.bare, "rev-parse", "content");
const isAncestor = (s: Scenario, a: string, b: string) => {
  try {
    git(s.bare, "merge-base", "--is-ancestor", a, b);
    return true;
  } catch {
    return false;
  }
};

it("commits and pushes raw/ and images/ on a first run, and nothing on the second", async () => {
  const s = scenario();
  const before = tip(s);
  const first = await runScript(s);
  expect(first.err).toBe("");
  expect(first.code).toBe(0);
  const files = originFiles(s);
  expect(files).toEqual(expect.arrayContaining(["raw/hello-world.xml", "raw/second-post.xml", "raw/just-text.xml"]));
  expect(files.some((f) => f.startsWith("images/"))).toBe(true);
  expect(files.every((f) => f.startsWith("raw/") || f.startsWith("images/"))).toBe(true);
  expect(git(s.bare, "log", "-1", "--format=%s", "content")).toMatch(/^backup: \d+ new or changed items, \d+ images$/);
  expect(git(s.bare, "log", "-1", "--format=%an <%ae>", "content")).toBe("Owner <owner@example.com>");
  expect(first.out).toMatch(/^scrape:local: pushed/m);
  const afterFirst = tip(s);
  expect(afterFirst).not.toBe(before);
  expect(isAncestor(s, before, afterFirst)).toBe(true);

  const second = await runScript(s);
  expect(second.code).toBe(0);
  expect(second.out).toContain("nothing new");
  expect(tip(s)).toBe(afterFirst);
  // The lock is released after each run.
  expect(existsSync(join(s.clone, ".git", "substacker-scrape.lock"))).toBe(false);
});

it("works for a feed with no images", async () => {
  const s = scenario();
  const r = await runScript(s, [], {}, "/noimg");
  expect(r.code).toBe(0);
  expect(originFiles(s)).toEqual(["raw/plain.xml"]);
  expect(git(s.bare, "log", "-1", "--format=%s", "content")).toBe("backup: 1 new or changed item, 0 images");
});

it("refuses a dirty worktree and leaves it as it was", async () => {
  const s = scenario();
  expect((await runScript(s)).code).toBe(0);
  const mine = join(s.clone, "content", "raw", "mine.xml");
  writeFileSync(mine, "local work");
  const before = tip(s);
  const r = await runScript(s);
  expect(r.code).toBe(1);
  expect(r.err).toMatch(/uncommitted changes/);
  expect(readFileSync(mine, "utf8")).toBe("local work");
  expect(tip(s)).toBe(before);
});

it("fast-forwards a worktree that is behind origin", async () => {
  const s = scenario();
  expect((await runScript(s)).code).toBe(0);
  // Another machine adds a file.
  const other = join(top, `other${counter}`);
  git(top, "clone", "-q", "--branch", "content", s.bare, other);
  writeFileSync(join(other, "raw", "elsewhere.xml"), "<item/>");
  git(other, "add", "-A");
  git(other, "commit", "-q", "-m", "elsewhere");
  git(other, "push", "-q", "origin", "content");
  const r = await runScript(s);
  expect(r.code).toBe(0);
  expect(existsSync(join(s.clone, "content", "raw", "elsewhere.xml"))).toBe(true);
  expect(originFiles(s)).toContain("raw/elsewhere.xml");
});

it("fails clearly without origin/content, and --init creates it without force", async () => {
  const s = scenario(false);
  const missing = await runScript(s);
  expect(missing.code).toBe(1);
  expect(missing.err).toContain("scrape:local -- --init");
  expect(git(s.bare, "branch", "--list", "content")).toBe("");

  const init = await runScript(s, ["--init"]);
  expect(init.code).toBe(0);
  expect(git(s.bare, "rev-list", "--count", "content").split("\n")[0]).toMatch(/^\d+$/);
  expect(originFiles(s).some((f) => f.startsWith("raw/"))).toBe(true);
  // The branch starts with one empty commit.
  const first = git(s.bare, "rev-list", "--max-parents=0", "content");
  expect(git(s.bare, "ls-tree", "-r", "--name-only", first)).toBe("");
  expect(git(s.bare, "log", "-1", "--format=%s", first)).toBe("Create the content branch");
});

it("--init with an existing branch changes nothing", async () => {
  const s = scenario();
  const before = tip(s);
  const r = await runScript(s, ["--init", "--dry-run"]);
  expect(r.code).toBe(2);
  expect(tip(s)).toBe(before);
  const ok = await runScript(s, ["--init"]);
  expect(ok.code).toBe(0);
  expect(ok.out).toContain("already has");
});

it("--dry-run commits locally and neither pushes nor dispatches", async () => {
  const s = scenario();
  const before = tip(s);
  const calls = apiCalls.length;
  const r = await runScript(s, ["--dry-run"], dispatchEnv());
  expect(r.code).toBe(0);
  expect(r.out).toContain("dry run");
  expect(tip(s)).toBe(before);
  expect(git(join(s.clone, "content"), "rev-list", "--count", "origin/content..HEAD")).toBe("1");
  expect(apiCalls.length).toBe(calls);
  // A later real run pushes that commit and asks for a deploy.
  const real = await runScript(s, [], dispatchEnv());
  expect(real.code).toBe(0);
  expect(tip(s)).not.toBe(before);
  expect(apiCalls.length).toBe(calls + 1);
});

it("asks GitHub to run the workflow after a new commit, and not when nothing changed", async () => {
  const s = scenario();
  apiCalls.length = 0;
  apiStatus = 204;
  const r = await runScript(s, [], dispatchEnv("secret-token-xyz"));
  expect(r.code).toBe(0);
  expect(r.out).toContain("deploy requested");
  expect(apiCalls).toHaveLength(1);
  const call = apiCalls[0] as ApiCall;
  expect(call.method).toBe("POST");
  expect(call.url).toBe("/repos/example-owner/example-repo/actions/workflows/publish.yml/dispatches");
  expect(JSON.parse(call.body)).toEqual({ ref: "main" });
  expect(call.headers["authorization"]).toBe("Bearer secret-token-xyz");
  expect(call.headers["accept"]).toBe("application/vnd.github+json");
  expect(call.headers["x-github-api-version"]).toBe("2022-11-28");
  // The token is never printed.
  expect(r.out + r.err).not.toContain("secret-token-xyz");

  const again = await runScript(s, [], dispatchEnv());
  expect(again.code).toBe(0);
  expect(apiCalls).toHaveLength(1);
});

it("--no-dispatch pushes without calling the API", async () => {
  const s = scenario();
  apiCalls.length = 0;
  const r = await runScript(s, ["--no-dispatch"], dispatchEnv());
  expect(r.code).toBe(0);
  expect(apiCalls).toHaveLength(0);
  expect(originFiles(s).length).toBeGreaterThan(0);
});

it("a failing, unreachable or absent dispatch is a warning, not an error", async () => {
  apiStatus = 403;
  const failing = scenario();
  const a = await runScript(failing, [], dispatchEnv("tok-403"));
  apiStatus = 204;
  expect(a.code).toBe(0);
  expect(a.err).toContain("403");
  expect(a.err).not.toContain("tok-403");
  expect(originFiles(failing).length).toBeGreaterThan(0);

  const unreachable = scenario();
  const b = await runScript(unreachable, [], { ...dispatchEnv("tok-down"), SUBSTACKER_API_URL: "http://127.0.0.1:9" });
  expect(b.code).toBe(0);
  expect(b.err).toContain("warning");
  expect(b.err).not.toContain("tok-down");

  const none = scenario();
  const c = await runScript(none);
  expect(c.code).toBe(0);
  expect(c.out).toContain("no dispatch token");
});

it("takes the repository from a GitHub remote address when SUBSTACKER_REPO is unset", async () => {
  const s = scenario();
  git(s.clone, "remote", "set-url", "--push", "origin", s.bare);
  // The fetch address is a github.com one; pushes still go to the bare repository.
  git(s.clone, "config", "url.file://" + s.bare + ".insteadOf", "https://github.com/example-owner/example-repo.git");
  git(s.clone, "remote", "set-url", "origin", "https://github.com/example-owner/example-repo.git");
  apiCalls.length = 0;
  const { SUBSTACKER_REPO: _unused, ...env } = dispatchEnv();
  void _unused;
  const r = await runScript(s, [], env);
  expect(r.code).toBe(0);
  expect(apiCalls.map((c) => c.url)).toEqual(["/repos/example-owner/example-repo/actions/workflows/publish.yml/dispatches"]);
});

it("refuses to run while another run holds the lock, and takes over a stale one", async () => {
  const s = scenario();
  const lock = join(s.clone, ".git", "substacker-scrape.lock");
  writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
  const busy = await runScript(s);
  expect(busy.code).toBe(2);
  expect(busy.err).toMatch(/in progress/);
  expect(existsSync(lock)).toBe(true);

  writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 + 12345, startedAt: Date.now() }));
  const stale = await runScript(s);
  expect(stale.code).toBe(0);
  expect(existsSync(lock)).toBe(false);
});

it("fails with a clear message when git has no identity", async () => {
  const s = scenario();
  git(s.clone, "config", "--unset", "user.name");
  git(s.clone, "config", "--unset", "user.email");
  const r = await runScript(s, [], { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", HOME: s.clone });
  expect(r.code).toBe(1);
  expect(r.err).toMatch(/No git identity/);
});

it("fails on a missing configuration with the loader's message, and on a bad option", async () => {
  const s = scenario();
  const noConfig = await runScript(s, [], { SUBSTACKER_CONFIG: "" });
  expect(noConfig.code).toBe(1);
  expect(noConfig.err).toContain("substacker.config.example.json");
  const bad = await runScript(s, ["--force"]);
  expect(bad.code).toBe(2);
});

it("never forces: origin's content only ever fast-forwards, and the script has no force option", async () => {
  const s = scenario();
  const tips = [tip(s)];
  await runScript(s);
  tips.push(tip(s));
  // Another machine pushes between two runs; this machine's run merges it in.
  const other = join(top, `race${counter}`);
  git(top, "clone", "-q", "--branch", "content", s.bare, other);
  writeFileSync(join(other, "raw", "other.xml"), "<item/>");
  git(other, "add", "-A");
  git(other, "commit", "-q", "-m", "other");
  git(other, "push", "-q", "origin", "content");
  tips.push(tip(s));
  await runScript(s);
  tips.push(tip(s));
  for (let i = 1; i < tips.length; i++) expect(isAncestor(s, tips[i - 1] as string, tips[i] as string)).toBe(true);
  const source = readFileSync(script, "utf8").replace(/\/\/.*$/gm, "");
  expect(source).not.toMatch(/--force|\+refs|--delete|reset --hard|"-f"/);
  expect(readdirSync(join(s.bare, "refs", "heads"))).toContain("content");
});
