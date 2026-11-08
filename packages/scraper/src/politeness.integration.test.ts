import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { diskBackup, writeChanges } from "./backup.js";
import type { Config } from "./config.js";
import { createPinnedFetch } from "./net.js";
import { scrape } from "./scrape.js";
import { feedXml } from "./test-support/feeds.js";

// The real transport against a local server that records what reaches it.

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64");
let server: Server;
let origin = "";
let active = 0;
let peak = 0;
let handled: string[] = [];
let limitFirst = 0; // answer the first N image requests with 429
let retryAfter: string | undefined;
let work = "";

beforeEach(async () => {
  active = 0; peak = 0; handled = []; limitFirst = 0; retryAfter = undefined;
  work = mkdtempSync(join(tmpdir(), "substacker-polite-"));
  server = createServer((req, res) => {
    const url = req.url ?? "/";
    if (url === "/feed") {
      const imgs = Array.from({ length: 12 }, (_, i) => `<img src="${origin}/img/${i}.png">`).join("");
      res.writeHead(200).end(feedXml([{ title: "A", link: "https://example.substack.com/p/a", body: imgs }]));
      return;
    }
    handled.push(url);
    if (limitFirst > 0) {
      limitFirst--;
      res.writeHead(429, retryAfter ? { "retry-after": retryAfter } : {}).end();
      return;
    }
    active++; peak = Math.max(peak, active);
    setTimeout(() => { active--; res.writeHead(200, { "content-type": "image/png" }).end(PNG); }, 20);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(work, { recursive: true, force: true });
});

const config = (extra: Partial<Config> = {}): Config => ({ feedUrl: `${origin}/feed`, feedName: "T", actions: [], utmSource: "s", hidden: [], ...extra });
const deps = (sleeps: number[] = []) => ({
  fetch: createPinnedFetch({ allowPrivate: true }),
  allowPrivate: true,
  backup: diskBackup(work),
  sleep: async (ms: number) => void sleeps.push(ms),
});

describe("polite image downloads over the real transport", () => {
  it("keeps at most 2 requests in flight to one host, whatever the overall limit", async () => {
    const changes = await scrape(config({ maxConcurrentDownloads: 8 }), deps());
    expect(changes.filter((c) => c.kind === "image")).toHaveLength(12);
    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBeGreaterThan(0);
  });
  it("serialises with a limit of 1", async () => {
    await scrape(config({ maxConcurrentDownloads: 1 }), deps());
    expect(peak).toBe(1);
  });
  it("honours Retry-After seconds from the real server and then succeeds", async () => {
    limitFirst = 2;
    retryAfter = "3";
    const sleeps: number[] = [];
    const changes = await scrape(config(), deps(sleeps));
    expect(changes.filter((c) => c.kind === "image")).toHaveLength(12);
    expect(sleeps.filter((s) => s === 3000).length).toBe(2);
  });
  it("gives up on a host that keeps answering 429 and a later run fetches the rest", async () => {
    limitFirst = 1000;
    const logs: string[] = [];
    const first = await scrape(config(), { ...deps(), log: (m) => logs.push(m) });
    expect(first.filter((c) => c.kind === "image")).toHaveLength(0);
    // 4 answers trip the host; a second request already in flight may add one more.
    expect(handled.length).toBeLessThanOrEqual(5);
    expect(logs.filter((m) => /keeps answering 429/.test(m))).toHaveLength(1);
    writeChanges(work, first);
    limitFirst = 0;
    const second = await scrape(config(), deps());
    expect(second.filter((c) => c.kind === "image")).toHaveLength(12);
    writeChanges(work, second);
    handled = [];
    expect((await scrape(config(), deps())).filter((c) => c.kind === "image")).toHaveLength(0);
    expect(handled).toEqual([]);
  });
  it("refuses an image on a loopback address when the transport is strict", async () => {
    const strict = createPinnedFetch();
    const feedOnly: typeof fetch = (input, init) =>
      String(input).endsWith("/feed") ? createPinnedFetch({ allowPrivate: true })(input, init) : strict(input, init);
    const logs: string[] = [];
    const changes = await scrape(config(), { ...deps(), fetch: feedOnly, log: (m) => logs.push(m) });
    expect(changes.filter((c) => c.kind === "image")).toHaveLength(0);
    expect(handled).toEqual([]);
    expect(logs.join("\n")).toMatch(/will retry next run/);
  });
});
