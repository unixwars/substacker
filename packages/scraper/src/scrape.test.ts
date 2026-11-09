import { imageKey } from "substacker-core";
import { describe, expect, it } from "vitest";
import type { Config } from "./config.js";
import { imageUrls } from "./derive.js";
import { parseFeed } from "./feed.js";
import type { BackupReader, Change, ScrapeDeps } from "./scrape.js";
import { ScrapeError, scrape as realScrape } from "./scrape.js";
import { feedXml, fixtureFeed } from "./test-support/feeds.js";

const config: Config = { feedUrl: "https://example.substack.com/feed", feedName: "T", actions: [], utmSource: "substacker", noindex: true, hidden: [] };

// No real waiting in tests: the pauses and backoffs are skipped.
const scrape = (c: Config, d: ScrapeDeps) => realScrape(c, { sleep: async () => undefined, ...d });

class Memory implements BackupReader {
  raw = new Map<string, string>();
  images = new Set<string>(); // file names, `<key>.<ext>`
  slugs = () => [...this.raw.keys()];
  readRaw = (s: string) => this.raw.get(s);
  hasImage = (key: string) => [...this.images].some((n) => n.startsWith(`${key}.`));
  apply(changes: Change[]) {
    for (const c of changes) {
      if (c.kind === "raw") this.raw.set(c.slug, c.content);
      else this.images.add(c.name);
    }
  }
}

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const respond = (body: BodyInit, init: ResponseInit = {}) => new Response(body, { status: 200, ...init });
function fetcher(feed: string | (() => Response), failImages = false, image: () => Response = () => respond(PNG, { headers: { "content-type": "image/png" } })) {
  const calls: string[] = [];
  const fn = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url === config.feedUrl) return typeof feed === "function" ? feed() : respond(feed);
    if (failImages) return new Response("no", { status: 500 });
    return image();
  }) as typeof fetch;
  return { fn, calls };
}

describe("scrape with an unusable feed item", () => {
  it("does not write it to the backup and logs why", async () => {
    const xml = feedXml([
      { title: "Good", link: "https://example.substack.com/p/good" },
      { title: "No date", link: "https://example.substack.com/p/nodate", pubDate: "" },
    ]);
    const logs: string[] = [];
    const changes = await scrape(config, { fetch: fetcher(xml).fn, backup: new Memory(), log: (m) => logs.push(m) });
    expect(changes.filter((c) => c.kind === "raw").map((c) => (c as { slug: string }).slug)).toEqual(["good"]);
    expect(logs.join("\n")).toMatch(/nodate/);
  });
  it("still scrapes when an earlier bad raw file is already in the backup", async () => {
    const backup = new Memory();
    backup.raw.set("old-bad", "<item><link>https://example.substack.com/p/old-bad</link></item>");
    const changes = await scrape(config, { fetch: fetcher(feedXml([{ title: "Good", link: "https://example.substack.com/p/good" }])).fn, backup });
    expect(changes.filter((c) => c.kind === "raw")).toHaveLength(1);
  });
});

describe("scrape", () => {
  it("returns raw items and images for an empty backup", async () => {
    const backup = new Memory();
    const changes = await scrape(config, { fetch: fetcher(fixtureFeed).fn, backup });
    expect(changes.filter((c) => c.kind === "raw")).toHaveLength(3);
    const expectedImages = new Set(parseFeed(fixtureFeed).flatMap((i) => imageUrls(i.raw)).map(imageKey));
    const names = changes.filter((c) => c.kind === "image").map((c) => (c as { name: string }).name);
    expect(new Set(names.map((n) => n.replace(/\.png$/, "")))).toEqual(expectedImages);
    expect(names.every((n) => /^[0-9a-f]{14}\.png$/.test(n))).toBe(true);
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
  it("a 403 without a relay says to set one up", async () => {
    const f = fetcher(() => new Response("blocked", { status: 403 }));
    await expect(scrape(config, { fetch: f.fn, backup: new Memory() })).rejects.toThrow(/HTTP 403.*relayUrl/);
  });
  it("a 403 through the relay is a plain failure", async () => {
    const fn = (async () => new Response("no", { status: 403 })) as typeof fetch;
    const err = await scrape({ ...config, relayUrl: "https://relay.example.workers.dev" }, { fetch: fn, backup: new Memory(), env: { SUBSTACKER_RELAY_SECRET: "s" } }).catch((e: unknown) => e);
    expect(String(err)).toMatch(/HTTP 403/);
    expect(String(err)).not.toMatch(/set relayUrl/);
  });
  it("says whether the relay itself refused or the publication answered through it", async () => {
    const run = (res: () => Response) =>
      scrape({ ...config, relayUrl: "https://relay.example.workers.dev" }, { fetch: (async () => res()) as typeof fetch, backup: new Memory(), env: { SUBSTACKER_RELAY_SECRET: "s" } }).catch((e: unknown) => String(e));
    expect(await run(() => new Response("x", { status: 403, headers: { "x-relay-error": "host not allowed" } }))).toMatch(/the relay refused \(HTTP 403: host not allowed\)/);
    expect(await run(() => new Response("x", { status: 403 }))).toMatch(/via the relay, from the publication.*HTTP 403/);
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
  it("names the extension from the bytes, whatever the address and Content-Type say", async () => {
    const jpg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
    const f = fetcher(fixtureFeed, false, () => respond(jpg, { headers: { "content-type": "application/octet-stream" } }));
    const changes = await scrape(config, { fetch: f.fn, backup: new Memory() });
    const names = changes.filter((c) => c.kind === "image").map((c) => (c as { name: string }).name);
    expect(names.length).toBeGreaterThan(0);
    expect(names.every((n) => n.endsWith(".jpg"))).toBe(true);
  });
  it("falls back to the Content-Type when the bytes are not recognised", async () => {
    const f = fetcher(fixtureFeed, false, () => respond("??", { headers: { "content-type": "image/webp" } }));
    const changes = await scrape(config, { fetch: f.fn, backup: new Memory() });
    expect(changes.filter((c) => c.kind === "image").every((c) => (c as { name: string }).name.endsWith(".webp"))).toBe(true);
  });
  it("treats an unrecognised download as failed: no .bin, retried next run", async () => {
    const backup = new Memory();
    const logs: string[] = [];
    const bad = fetcher(fixtureFeed, false, () => respond("<html>blocked</html>", { headers: { "content-type": "text/html" } }));
    const first = await scrape(config, { fetch: bad.fn, backup, log: (m) => logs.push(m) });
    expect(first.filter((c) => c.kind === "image")).toEqual([]);
    expect(logs.some((m) => /not a recognised image/.test(m))).toBe(true);
    backup.apply(first);
    const second = await scrape(config, { fetch: fetcher(fixtureFeed).fn, backup });
    expect(second.filter((c) => c.kind === "image").length).toBeGreaterThan(0);
  });
  it("does not download an image that is present under any extension", async () => {
    const backup = new Memory();
    backup.apply(await scrape(config, { fetch: fetcher(fixtureFeed).fn, backup }));
    backup.images = new Set([...backup.images].map((n) => n.replace(/\.png$/, ".avif")));
    const f = fetcher(fixtureFeed);
    expect(await scrape(config, { fetch: f.fn, backup })).toEqual([]);
    expect(f.calls).toEqual([config.feedUrl]);
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

describe("scrape image hardening", () => {
  const one = (body: string) => feedXml([{ title: "A", link: "https://example.substack.com/p/a", body }]);
  const svgResponse = (svg: string) => () => respond(svg, { headers: { "content-type": "image/svg+xml" } });
  const imageChange = (changes: Change[]) => changes.find((c) => c.kind === "image") as Extract<Change, { kind: "image" }> | undefined;

  it("stores an SVG, sanitized", async () => {
    const hostile = `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script><use href="https://evil.test/x.svg#a"/><rect width="4" height="4"/></svg>`;
    const f = fetcher(one('<img src="https://cdn.example.test/a.svg">'), false, svgResponse(hostile));
    const img = imageChange(await scrape(config, { fetch: f.fn, backup: new Memory() }));
    expect(img?.name).toMatch(/\.svg$/);
    const text = new TextDecoder().decode(img?.data);
    expect(text).toContain("<rect");
    expect(text).not.toMatch(/script|onload|evil\.test|alert/);
  });
  it("treats an SVG with nothing valid left as a failed download, retried next run", async () => {
    const logs: string[] = [];
    const f = fetcher(one('<img src="https://cdn.example.test/a.svg">'), false, () => respond("<svg", { headers: { "content-type": "image/svg+xml" } }));
    const backup = new Memory();
    const changes = await scrape(config, { fetch: f.fn, backup, log: (m) => logs.push(m) });
    expect(imageChange(changes)).toBeUndefined();
    expect(logs.join("\n")).toMatch(/will retry next run/);
  });
  it("does not download a stored SVG again", async () => {
    const f = fetcher(one('<img src="https://cdn.example.test/a.svg">'), false, svgResponse('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>'));
    const backup = new Memory();
    backup.apply(await scrape(config, { fetch: f.fn, backup }));
    const before = f.calls.length;
    expect(await scrape(config, { fetch: f.fn, backup })).toEqual([]);
    expect(f.calls.slice(before)).toEqual([config.feedUrl]);
  });
  it.each(["http://127.0.0.1/internal", "https://169.254.169.254/latest/meta-data", "https://2130706433/x", "https://[::ffff:7f00:1]/x", "ftp://example.test/x", "file:///etc/passwd"])(
    "refuses to fetch %s and counts it as a failed download",
    async (src) => {
      const logs: string[] = [];
      const f = fetcher(one(`<img src="${src}">`));
      const changes = await scrape(config, { fetch: f.fn, backup: new Memory(), log: (m) => logs.push(m) });
      expect(imageChange(changes)).toBeUndefined();
      expect(f.calls).toEqual([config.feedUrl]);
    },
  );
  it("refuses a redirect from a public image address to a private one", async () => {
    const calls: string[] = [];
    const fn = (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url === config.feedUrl) return respond(one('<img src="https://cdn.example.test/r">'));
      return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } });
    }) as typeof fetch;
    const changes = await scrape(config, { fetch: fn, backup: new Memory() });
    expect(imageChange(changes)).toBeUndefined();
    expect(calls).toEqual([config.feedUrl, "https://cdn.example.test/r"]);
  });
  it("leaves a rate-limited host's images for the next run, post unlocalized, and logs once", async () => {
    const body = [1, 2, 3].map((n) => `<img src="https://slow.example.test/${n}.png">`).join("") + '<img src="https://fine.example.test/ok.png">';
    const logs: string[] = [];
    const calls: string[] = [];
    const fn = (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url === config.feedUrl) return respond(one(body));
      if (url.includes("slow.")) return new Response("", { status: 429, headers: { "retry-after": "1" } });
      return respond(PNG, { headers: { "content-type": "image/png" } });
    }) as typeof fetch;
    const changes = await scrape({ ...config, maxConcurrentDownloads: 1 }, { fetch: fn, backup: new Memory(), log: (m) => logs.push(m) });
    expect(changes.filter((c) => c.kind === "image")).toHaveLength(1);
    expect(calls.filter((u) => u.includes("slow."))).toHaveLength(4);
    expect(logs.filter((m) => /keeps answering 429/.test(m))).toHaveLength(1);
  });
  it("retries a feed that answers 503 a bounded number of times, then reports it", async () => {
    let n = 0;
    const fn = (async () => (n++, new Response("busy", { status: 503, headers: { "retry-after": "2" } }))) as typeof fetch;
    await expect(scrape(config, { fetch: fn, backup: new Memory() })).rejects.toThrow(/HTTP 503/);
    expect(n).toBe(4);
  });
  it("applies the same retry bound to the relay", async () => {
    let n = 0;
    const fn = (async () => (n++, new Response("busy", { status: 429 }))) as typeof fetch;
    await expect(
      scrape({ ...config, relayUrl: "https://relay.example.workers.dev" }, { fetch: fn, backup: new Memory(), env: { SUBSTACKER_RELAY_SECRET: "s" } }),
    ).rejects.toThrow(/HTTP 429/);
    expect(n).toBe(4);
  });
  it("sends a user agent that names this project", async () => {
    let ua = "";
    const fn = (async (_i: RequestInfo | URL, init?: RequestInit) => ((ua = new Headers(init?.headers).get("user-agent") ?? ""), respond(feedXml([]))) ) as typeof fetch;
    await scrape(config, { fetch: fn, backup: new Memory() });
    expect(ua).toMatch(/^substacker-scraper\//);
  });
});
