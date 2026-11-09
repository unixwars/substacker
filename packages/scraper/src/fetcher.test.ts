import { describe, expect, it } from "vitest";
import { FetchError, Fetcher, parseRetryAfter } from "./fetcher.js";

const bytes = (n: number) => new Uint8Array(n).fill(1);
const ok = (body: BodyInit = "x", init: ResponseInit = {}) => new Response(body, { status: 200, ...init });
const GET = { maxBytes: 1000, timeoutMs: 1000 };

function make(fetchFn: (url: string, init?: RequestInit) => Promise<Response>, extra: Partial<ConstructorParameters<typeof Fetcher>[0]> = {}) {
  const sleeps: number[] = [];
  const logs: string[] = [];
  const f = new Fetcher({
    fetch: fetchFn as typeof fetch,
    sleep: async (ms) => void sleeps.push(ms),
    random: () => 0.5,
    now: () => 1_000_000,
    log: (m) => logs.push(m),
    ...extra,
  });
  return { f, sleeps, logs };
}

describe("parseRetryAfter", () => {
  it("reads seconds and HTTP dates", () => {
    expect(parseRetryAfter("7", 0)).toBe(7000);
    expect(parseRetryAfter(new Date(1_005_000).toUTCString(), 1_000_000)).toBe(5000);
    expect(parseRetryAfter(new Date(900_000).toUTCString(), 1_000_000)).toBe(0);
    expect(parseRetryAfter("soon", 0)).toBeUndefined();
    expect(parseRetryAfter(null, 0)).toBeUndefined();
  });
});

describe("Fetcher safety", () => {
  it.each(["http://example.test/a", "ftp://example.test/a", "https://127.0.0.1/a", "https://169.254.169.254/latest", "https://[::ffff:7f00:1]/", "https://2130706433/"])(
    "refuses %s without a request",
    async (url) => {
      let calls = 0;
      const { f } = make(async () => (calls++, ok()));
      await expect(f.get(url, GET)).rejects.toBeInstanceOf(FetchError);
      expect(calls).toBe(0);
    },
  );
  it("re-validates every redirect hop", async () => {
    const seen: string[] = [];
    const { f } = make(async (url) => {
      seen.push(url);
      return new Response(null, { status: 302, headers: { location: "https://169.254.169.254/latest/meta-data" } });
    });
    await expect(f.get("https://cdn.example.test/a.png", GET)).rejects.toThrow(/private|loopback/);
    expect(seen).toEqual(["https://cdn.example.test/a.png"]);
  });
  it("refuses a redirect to plain http and gives up after 5 hops", async () => {
    const a = make(async () => new Response(null, { status: 302, headers: { location: "http://cdn.example.test/b" } }));
    await expect(a.f.get("https://cdn.example.test/a", GET)).rejects.toThrow(/https/);
    let n = 0;
    const b = make(async () => (n++, new Response(null, { status: 302, headers: { location: `https://cdn.example.test/${n}` } })));
    await expect(b.f.get("https://cdn.example.test/0", GET)).rejects.toThrow(/too many redirects/);
    expect(n).toBe(6);
  });
  it("lets a caller refuse a redirect", async () => {
    const { f } = make(async () => new Response(null, { status: 302, headers: { location: "https://other.example.test/" } }));
    await expect(
      f.get("https://a.example.test/", { ...GET, onRedirect: (next) => { throw new FetchError(`no ${next.host}`); } }),
    ).rejects.toThrow(/no other/);
  });
  it("allows loopback and http only with allowPrivate", async () => {
    const { f } = make(async () => ok("hi"), { allowPrivate: true });
    expect((await f.get("http://127.0.0.1:1/a", GET)).status).toBe(200);
  });
});

describe("Fetcher limits", () => {
  it("aborts a body mid-stream once it passes the cap", async () => {
    let cancelled = false;
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) { pulled++; c.enqueue(bytes(400)); },
      cancel() { cancelled = true; },
    });
    const { f } = make(async () => new Response(body, { status: 200 }));
    await expect(f.get("https://cdn.example.test/a", { maxBytes: 1000, timeoutMs: 1000 })).rejects.toThrow(/too large/);
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThan(10);
  });
  it("refuses at once when content-length is over the cap", async () => {
    const { f } = make(async () => ok("x", { headers: { "content-length": "5000" } }));
    await expect(f.get("https://cdn.example.test/a", GET)).rejects.toThrow(/too large/);
  });
  it("passes a timeout signal to every request", async () => {
    let signal: AbortSignal | null | undefined;
    const { f } = make(async (_u, init) => (signal = init?.signal, ok()));
    await f.get("https://cdn.example.test/a", { ...GET, timeoutMs: 30_000 });
    expect(signal).toBeInstanceOf(AbortSignal);
  });
  it("never exceeds the overall or the per-host concurrency", async () => {
    let active = 0, peak = 0;
    const byHost = new Map<string, number>();
    let peakHost = 0;
    const { f } = make(async (url) => {
      const host = new URL(url).host;
      active++; peak = Math.max(peak, active);
      byHost.set(host, (byHost.get(host) ?? 0) + 1);
      peakHost = Math.max(peakHost, byHost.get(host)!);
      await new Promise((r) => setTimeout(r, 5));
      active--; byHost.set(host, byHost.get(host)! - 1);
      return ok();
    });
    const urls = Array.from({ length: 30 }, (_, i) => `https://h${i % 3}.example.test/${i}`);
    await Promise.all(urls.map((u) => f.get(u, GET)));
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(2);
    expect(peakHost).toBeLessThanOrEqual(2);
  });
  it("spaces requests to one host", async () => {
    const { f, sleeps } = make(async () => ok(), { now: () => 0, perHost: 1 });
    await Promise.all([f.get("https://a.example.test/1", GET), f.get("https://a.example.test/2", GET)]);
    expect(sleeps.length).toBeGreaterThan(0);
    expect(sleeps.every((s) => s > 0)).toBe(true);
  });
});

describe("Fetcher 429 and 503", () => {
  const limited = (headers: Record<string, string>, status = 429) => async () => new Response("slow", { status, headers });
  it("honours Retry-After in seconds, then succeeds", async () => {
    let n = 0;
    const { f, sleeps } = make(async () => (++n < 3 ? new Response("", { status: 429, headers: { "retry-after": "7" } }) : ok("done")));
    expect((await f.get("https://cdn.example.test/a", GET)).status).toBe(200);
    expect(n).toBe(3);
    expect(sleeps.filter((s) => s === 7000)).toHaveLength(2);
  });
  it("honours Retry-After as an HTTP date", async () => {
    let n = 0;
    const date = new Date(1_012_000).toUTCString();
    const { f, sleeps } = make(async () => (++n < 2 ? new Response("", { status: 503, headers: { "retry-after": date } }) : ok()));
    await f.get("https://cdn.example.test/a", GET);
    expect(sleeps).toContain(12_000);
  });
  it("caps one wait at 60 s", async () => {
    let n = 0;
    const { f, sleeps } = make(async () => (++n < 2 ? new Response("", { status: 429, headers: { "retry-after": "3600" } }) : ok()));
    await f.get("https://cdn.example.test/a", GET);
    expect(Math.max(...sleeps)).toBe(60_000);
  });
  it("backs off exponentially with jitter without a header, and stops after 3 retries", async () => {
    let n = 0;
    const { f, sleeps } = make(async () => (n++, new Response("", { status: 503 })), { hostGapMs: 0 });
    const res = await f.get("https://cdn.example.test/a", GET);
    expect(res.status).toBe(503);
    expect(n).toBe(4);
    const waits = sleeps;
    expect(waits).toHaveLength(3);
    expect(waits[1]!).toBeGreaterThan(waits[0]!);
    expect(waits[2]!).toBeGreaterThan(waits[1]!);
    expect(Math.max(...waits)).toBeLessThanOrEqual(60_000);
  });
  it("stops asking a host that keeps answering 429, and logs it once", async () => {
    const calls: string[] = [];
    const { f, logs } = make(async (url) => (calls.push(url), new Response("", { status: 429, headers: { "retry-after": "1" } })));
    expect((await f.get("https://slow.example.test/1", GET)).status).toBe(429);
    expect(calls).toHaveLength(4);
    await expect(f.get("https://slow.example.test/2", GET)).rejects.toThrow(/rate limiting/);
    await expect(f.get("https://slow.example.test/3", GET)).rejects.toThrow(/rate limiting/);
    expect(calls).toHaveLength(4);
    expect(logs.filter((l) => /slow\.example\.test/.test(l))).toHaveLength(1);
    // Other hosts are unaffected.
    const other = make(async () => ok());
    expect((await other.f.get("https://fine.example.test/1", GET)).status).toBe(200);
  });
  it("does not trip a host on 503 alone", async () => {
    const { f } = make(limited({}, 503));
    await f.get("https://a.example.test/1", GET);
    expect(f.isTripped("a.example.test")).toBe(false);
  });
});
