import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDocs, parseIndex, parsePost } from "substacker-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { diskBackup } from "./backup.js";
import { runBuild, runScrape } from "./cli.js";
import type { Config } from "./config.js";
import { scrape } from "./scrape.js";
import { fixtureFeed } from "./test-support/feeds.js";

// Scrape then build against a fixture feed served by a local HTTP server.

let server: Server;
let origin = "";
let mode: "ok" | "down" | "redirect" = "ok";
const requested: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? "/";
    requested.push(url);
    if (url === "/feed") {
      if (mode === "down") { res.writeHead(503).end("down"); return; }
      if (mode === "redirect") { res.writeHead(302, { location: "http://stranger.invalid/feed" }).end(); return; }
      res.writeHead(200, { "content-type": "application/rss+xml" }).end(fixtureFeed.replaceAll("https://substackcdn.com", origin).replaceAll("https://images.unsplash.com", origin));
      return;
    }
    res.writeHead(200, { "content-type": "image/jpeg" }).end(Buffer.from(`image:${url}`));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

let work = "";
let env: Record<string, string>;
let config: Config;
beforeEach(() => {
  mode = "ok";
  requested.length = 0;
  work = mkdtempSync(join(tmpdir(), "substacker-flow-"));
  config = { feedUrl: `${origin}/feed`, feedName: "Example Newsletter", actions: [], utmSource: "substacker", hidden: [] };
  env = { SUBSTACKER_CONFIG: JSON.stringify(config) };
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => { rmSync(work, { recursive: true, force: true }); vi.restoreAllMocks(); });

function snapshot(dir: string): string {
  const h = createHash("sha256");
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else h.update(p.slice(dir.length)).update(readFileSync(p));
    }
  };
  try { walk(dir); } catch { /* absent directory hashes as empty */ }
  return h.digest("hex");
}

const backup = () => join(work, "content");
const out = () => join(work, "site", "content");

describe("scrape then build", () => {
  it("backs up the feed and builds a readable site", async () => {
    await runScrape(["--backup", backup()], env);
    runBuild(["--backup", backup(), "--out", out()], env);
    const index = parseIndex(JSON.parse(readFileSync(join(out(), "index.json"), "utf8")));
    expect(index.posts.map((p) => p.slug)).toEqual(["just-text", "second-post", "hello-world"]);
    parseDocs(JSON.parse(readFileSync(join(out(), "search.json"), "utf8")));
    const post = parsePost(JSON.parse(readFileSync(join(out(), "posts", "hello-world.json"), "utf8")));
    expect(post.unlocalized).toBe(0);
    expect(post.html).toContain('src="images/');
    const names = readdirSync(join(out(), "images"));
    expect(names.length).toBeGreaterThan(0);
    // The fixture server sends unrecognisable bytes with an image Content-Type: the fallback names them.
    expect(names.every((n) => /^[0-9a-f]{14}\.jpg$/.test(n))).toBe(true);
  });

  it("is idempotent: a second scrape changes nothing and the build is identical", async () => {
    await runScrape(["--backup", backup()], env);
    runBuild(["--backup", backup(), "--out", out()], env);
    const backupBefore = snapshot(backup());
    const outBefore = snapshot(out());
    expect(await scrape(config, { fetch, backup: diskBackup(backup()) })).toEqual([]);
    await runScrape(["--backup", backup()], env);
    runBuild(["--backup", backup(), "--out", out()], env);
    expect(snapshot(backup())).toBe(backupBefore);
    expect(snapshot(out())).toBe(outBefore);
  });

  it("a down feed leaves the backup untouched and fails", async () => {
    await runScrape(["--backup", backup()], env);
    const before = snapshot(backup());
    mode = "down";
    await expect(runScrape(["--backup", backup()], env)).rejects.toThrow(/HTTP 503/);
    expect(snapshot(backup())).toBe(before);
  });

  it("a cross-host redirect aborts with nothing written", async () => {
    mode = "redirect";
    await expect(runScrape(["--backup", backup()], env)).rejects.toThrow(/another host/);
    expect(snapshot(backup())).toBe(snapshot(join(work, "does-not-exist")));
  });

  it("publishes with unlocalized images, then a later run retries them", async () => {
    // Images fail on the first run only.
    const flaky: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url !== config.feedUrl) return new Response("no", { status: 500 });
      return fetch(input, init);
    };
    const first = await scrape(config, { fetch: flaky, backup: diskBackup(backup()), log: () => undefined });
    expect(first.every((c) => c.kind === "raw")).toBe(true);
    const { writeChanges } = await import("./backup.js");
    writeChanges(backup(), first);
    runBuild(["--backup", backup(), "--out", out()], env);
    expect(parsePost(JSON.parse(readFileSync(join(out(), "posts", "hello-world.json"), "utf8"))).unlocalized).toBe(2);

    await runScrape(["--backup", backup()], env);
    runBuild(["--backup", backup(), "--out", out()], env);
    expect(parsePost(JSON.parse(readFileSync(join(out(), "posts", "hello-world.json"), "utf8"))).unlocalized).toBe(0);
  });

  it("hiding a slug removes it from the index and search; unhiding restores it without a new fetch", async () => {
    await runScrape(["--backup", backup()], env);
    const hiddenEnv = { SUBSTACKER_CONFIG: JSON.stringify({ ...config, hidden: ["second-post"] }) };
    runBuild(["--backup", backup(), "--out", out()], hiddenEnv);
    expect(parseIndex(JSON.parse(readFileSync(join(out(), "index.json"), "utf8"))).posts.map((p) => p.slug)).not.toContain("second-post");
    const fetched = requested.length;
    runBuild(["--backup", backup(), "--out", out()], env);
    expect(parseIndex(JSON.parse(readFileSync(join(out(), "index.json"), "utf8"))).posts.map((p) => p.slug)).toContain("second-post");
    expect(requested.length).toBe(fetched);
  });
});
