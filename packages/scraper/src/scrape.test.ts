import { imageName } from "substacker-core";
import { describe, expect, it } from "vitest";
import type { Config } from "./config.js";
import { imageUrls } from "./derive.js";
import { parseFeed } from "./feed.js";
import type { BackupReader, Change } from "./scrape.js";
import { ScrapeError, scrape } from "./scrape.js";
import { feedXml, fixtureFeed } from "./test-support/feeds.js";

const config: Config = { feedUrl: "https://example.substack.com/feed", feedName: "T", actions: [], utmSource: "substacker", hidden: [] };

class Memory implements BackupReader {
  raw = new Map<string, string>();
  images = new Set<string>();
  slugs = () => [...this.raw.keys()];
  readRaw = (s: string) => this.raw.get(s);
  hasImage = (n: string) => this.images.has(n);
  apply(changes: Change[]) {
    for (const c of changes) {
      if (c.kind === "raw") this.raw.set(c.slug, c.content);
      else this.images.add(c.name);
    }
  }
}

const respond = (body: string, init: ResponseInit = {}) => new Response(body, { status: 200, ...init });
function fetcher(feed: string | (() => Response), failImages = false) {
  const calls: string[] = [];
  const fn = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url === config.feedUrl) return typeof feed === "function" ? feed() : respond(feed);
    if (failImages) return new Response("no", { status: 500 });
    return respond("image-bytes");
  }) as typeof fetch;
  return { fn, calls };
}

describe("scrape", () => {
  it("returns raw items and images for an empty backup", async () => {
    const backup = new Memory();
    const changes = await scrape(config, { fetch: fetcher(fixtureFeed).fn, backup });
    expect(changes.filter((c) => c.kind === "raw")).toHaveLength(3);
    const expectedImages = new Set(parseFeed(fixtureFeed).flatMap((i) => imageUrls(i.raw)).map(imageName));
    expect(new Set(changes.filter((c) => c.kind === "image").map((c) => (c as { name: string }).name))).toEqual(expectedImages);
  });
  it("a second scrape returns no changes", async () => {
    const backup = new Memory();
    const f = fetcher(fixtureFeed);
    backup.apply(await scrape(config, { fetch: f.fn, backup }));
    expect(await scrape(config, { fetch: f.fn, backup })).toEqual([]);
  });
  it("an edited item changes only its own raw file", async () => {
    const backup = new Memory();
    backup.apply(await scrape(config, { fetch: fetcher(fixtureFeed).fn, backup }));
    const edited = fixtureFeed.replace("<![CDATA[Second post]]>", "<![CDATA[Second post, edited]]>");
    const changes = await scrape(config, { fetch: fetcher(edited).fn, backup });
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ kind: "raw", slug: "second-post" });
  });
  it("a post gone from the feed keeps its raw file and writes no deletion", async () => {
    const backup = new Memory();
    backup.apply(await scrape(config, { fetch: fetcher(fixtureFeed).fn, backup }));
    const changes = await scrape(config, { fetch: fetcher(feedXml([])).fn, backup });
    expect(changes).toEqual([]);
    expect(backup.raw.has("hello-world")).toBe(true);
  });
  it.each([
    ["a failed fetch", () => new Response("down", { status: 503 })],
    ["a malformed feed", () => respond("<rss><channel><item>")],
    ["not a feed", () => respond("<html></html>")],
  ])("%s throws and returns no changes", async (_n, feed) => {
    await expect(scrape(config, { fetch: fetcher(feed).fn, backup: new Memory() })).rejects.toThrow(ScrapeError);
  });
  it("a network error throws", async () => {
    const fn = (async () => { throw new TypeError("offline"); }) as typeof fetch;
    await expect(scrape(config, { fetch: fn, backup: new Memory() })).rejects.toThrow(/feed fetch failed/);
  });
  it("aborts on a redirect to another host", async () => {
    const f = fetcher(() => new Response(null, { status: 301, headers: { location: "https://stranger.example/feed" } }));
    await expect(scrape(config, { fetch: f.fn, backup: new Memory() })).rejects.toThrow(/another host/);
    expect(f.calls).toEqual([config.feedUrl]);
  });
  it("follows a redirect within the same host", async () => {
    let n = 0;
    const fn = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === config.feedUrl && n++ === 0) return new Response(null, { status: 301, headers: { location: "/feed2" } });
      if (url.endsWith("/feed2")) return respond(feedXml([]));
      return respond("x");
    }) as typeof fetch;
    expect(await scrape(config, { fetch: fn, backup: new Memory() })).toEqual([]);
  });
  it("still stores the raw items when an image fails, then retries the image next run", async () => {
    const backup = new Memory();
    const logs: string[] = [];
    const first = await scrape(config, { fetch: fetcher(fixtureFeed, true).fn, backup, log: (m) => logs.push(m) });
    expect(first.filter((c) => c.kind === "raw")).toHaveLength(3);
    expect(first.filter((c) => c.kind === "image")).toHaveLength(0);
    expect(logs.length).toBeGreaterThan(0);
    backup.apply(first);
    const second = await scrape(config, { fetch: fetcher(fixtureFeed).fn, backup });
    expect(second.filter((c) => c.kind === "raw")).toHaveLength(0);
    expect(second.filter((c) => c.kind === "image").length).toBeGreaterThan(0);
  });
  it("downloads a shared image once", async () => {
    const f = fetcher(fixtureFeed);
    await scrape(config, { fetch: f.fn, backup: new Memory() });
    const imageCalls = f.calls.filter((u) => u !== config.feedUrl);
    expect(new Set(imageCalls).size).toBe(imageCalls.length);
  });
});

describe("scrape through the relay", () => {
  const relayed: Config = { ...config, relayUrl: "https://relay.example.workers.dev" };
  it("fetches the feed from the relay with the secret header", async () => {
    let seen: { url: string; secret: string | null } | undefined;
    const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("https://relay.example.workers.dev")) {
        seen = { url, secret: new Headers(init?.headers).get("x-relay-secret") };
        return respond(feedXml([]));
      }
      return respond("x");
    }) as typeof fetch;
    await scrape(relayed, { fetch: fn, backup: new Memory(), env: { SUBSTACKER_RELAY_SECRET: "s3cret" } });
    expect(seen?.secret).toBe("s3cret");
    expect(new URL(seen?.url ?? "").searchParams.get("url")).toBe(config.feedUrl);
  });
  it("refuses to run without the secret", async () => {
    await expect(scrape(relayed, { fetch: fetcher("").fn, backup: new Memory(), env: {} })).rejects.toThrow(/SUBSTACKER_RELAY_SECRET/);
  });
});
