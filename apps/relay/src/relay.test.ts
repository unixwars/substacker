import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MAX_BODY_BYTES, VERSION, handle } from "./relay.js";
import type { Env } from "./relay.js";

const env: Env = { RELAY_SECRET: "s3cret-value", ALLOWED_HOST: "example.substack.com" };
const FEED = "https://example.substack.com/feed";

const relayRequest = (target: string | null, init: { method?: string; secret?: string | null } = {}) => {
  const url = new URL("https://relay.example.workers.dev/");
  if (target !== null) url.searchParams.set("url", target);
  const headers = new Headers();
  const secret = init.secret === undefined ? "s3cret-value" : init.secret;
  if (secret !== null) headers.set("x-relay-secret", secret);
  return new Request(url, { method: init.method ?? "GET", headers });
};

type Seen = { url: string; init: RequestInit | undefined };
function upstream(respond: (url: string) => Response) {
  const seen: Seen[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: String(input), init });
    return respond(String(input));
  }) as typeof fetch;
  return { fn, seen };
}
const ok = () => new Response("<rss/>", { status: 200, headers: { "content-type": "application/rss+xml" } });

describe("the shared secret", () => {
  it.each([
    ["missing", null],
    ["wrong", "nope"],
    ["a prefix of the right one", "s3cret"],
    ["empty", ""],
  ])("rejects a %s secret with 401 and fetches nothing", async (_n, secret) => {
    const up = upstream(ok);
    const res = await handle(relayRequest(FEED, { secret }), env, up.fn);
    expect(res.status).toBe(401);
    expect(up.seen).toEqual([]);
  });
  it("fails closed when the relay is not configured", async () => {
    const up = upstream(ok);
    expect((await handle(relayRequest(FEED), { RELAY_SECRET: "", ALLOWED_HOST: "example.substack.com" }, up.fn)).status).toBe(500);
    expect((await handle(relayRequest(FEED), { RELAY_SECRET: "s3cret-value", ALLOWED_HOST: "" }, up.fn)).status).toBe(500);
    expect(up.seen).toEqual([]);
  });
});

describe("what it will fetch", () => {
  it("rejects another host with 403", async () => {
    const up = upstream(ok);
    const res = await handle(relayRequest("https://stranger.example/feed"), env, up.fn);
    expect(res.status).toBe(403);
    expect(up.seen).toEqual([]);
  });
  it.each([
    ["a look-alike suffix", "https://example.substack.com.evil.example/feed"],
    ["a look-alike prefix", "https://evilexample.substack.com/feed"],
    ["credentials that hide the host", "https://example.substack.com@evil.example/feed"],
    ["another port", "https://example.substack.com:8443/feed"],
  ])("rejects %s", async (_n, target) => {
    const up = upstream(ok);
    const res = await handle(relayRequest(target), env, up.fn);
    expect(res.status).toBe(403);
    expect(up.seen).toEqual([]);
  });
  it("rejects plain http, a missing url and a malformed url", async () => {
    const up = upstream(ok);
    expect((await handle(relayRequest("http://example.substack.com/feed"), env, up.fn)).status).toBe(400);
    expect((await handle(relayRequest(null), env, up.fn)).status).toBe(400);
    expect((await handle(relayRequest("not a url"), env, up.fn)).status).toBe(400);
    expect(up.seen).toEqual([]);
  });
  it.each(["POST", "PUT", "DELETE", "HEAD"])("rejects %s with 405", async (method) => {
    const up = upstream(ok);
    const res = await handle(relayRequest(FEED, { method }), env, up.fn);
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET");
    expect(up.seen).toEqual([]);
  });
  it("matches the allowed host without regard to case", async () => {
    const up = upstream(ok);
    const res = await handle(relayRequest(FEED), { ...env, ALLOWED_HOST: "Example.Substack.com" }, up.fn);
    expect(res.status).toBe(200);
  });
});

describe("passing the response through", () => {
  it("returns the status and body of the allowed host", async () => {
    const up = upstream(ok);
    const res = await handle(relayRequest(FEED), env, up.fn);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<rss/>");
    expect(res.headers.get("content-type")).toBe("application/rss+xml");
    expect(up.seen).toHaveLength(1);
    expect(up.seen[0]?.url).toBe(FEED);
  });
  it("passes an error status through unchanged", async () => {
    const up = upstream(() => new Response("blocked", { status: 403, headers: { "content-type": "text/html" } }));
    const res = await handle(relayRequest(FEED), env, up.fn);
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("blocked");
  });
  it("identifies itself honestly and sends no secret upstream", async () => {
    const up = upstream(ok);
    await handle(relayRequest(FEED), env, up.fn);
    const headers = new Headers(up.seen[0]?.init?.headers);
    expect(headers.get("user-agent")).toBe(`substacker-relay/${VERSION}`);
    expect(headers.get("x-relay-secret")).toBeNull();
    expect(up.seen[0]?.init?.method ?? "GET").toBe("GET");
  });
  it("keeps VERSION in step with package.json", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });
});

describe("redirects", () => {
  it("follows a redirect within the allowed host", async () => {
    const up = upstream((url) => (url === FEED ? new Response(null, { status: 301, headers: { location: "/feed2" } }) : ok()));
    const res = await handle(relayRequest(FEED), env, up.fn);
    expect(res.status).toBe(200);
    expect(up.seen.map((s) => s.url)).toEqual([FEED, "https://example.substack.com/feed2"]);
  });
  it("rejects a redirect to another host and does not follow it", async () => {
    const up = upstream(() => new Response(null, { status: 302, headers: { location: "https://stranger.example/feed" } }));
    const res = await handle(relayRequest(FEED), env, up.fn);
    expect(res.status).toBe(403);
    expect(up.seen).toHaveLength(1);
  });
  it("gives up on a redirect loop", async () => {
    const up = upstream(() => new Response(null, { status: 302, headers: { location: FEED } }));
    expect((await handle(relayRequest(FEED), env, up.fn)).status).toBe(502);
  });
  it("answers 502 for a redirect without a location", async () => {
    const up = upstream(() => new Response(null, { status: 302 }));
    expect((await handle(relayRequest(FEED), env, up.fn)).status).toBe(502);
  });
});

describe("size cap", () => {
  it("rejects a body whose declared length is over the cap", async () => {
    const up = upstream(() => new Response("x", { headers: { "content-length": String(MAX_BODY_BYTES + 1) } }));
    expect((await handle(relayRequest(FEED), env, up.fn)).status).toBe(502);
  });
  it("rejects a body that turns out larger than the cap while streaming, without reading it all", async () => {
    let pulled = 0;
    const chunk = new Uint8Array(1024 * 1024);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(chunk);
        if (pulled > 1000) controller.close();
      },
    });
    const up = upstream(() => new Response(body));
    const res = await handle(relayRequest(FEED), env, up.fn);
    expect(res.status).toBe(502);
    expect(pulled).toBeLessThan(MAX_BODY_BYTES / chunk.byteLength + 3);
  });
  it("passes a body exactly at the cap", async () => {
    const up = upstream(() => new Response(new Uint8Array(MAX_BODY_BYTES)));
    const res = await handle(relayRequest(FEED), env, up.fn);
    expect(res.status).toBe(200);
    expect((await res.arrayBuffer()).byteLength).toBe(MAX_BODY_BYTES);
  });
});

describe("a failing upstream", () => {
  it("answers 502 when the fetch throws", async () => {
    const fn = (async () => { throw new TypeError("network"); }) as typeof fetch;
    expect((await handle(relayRequest(FEED), env, fn)).status).toBe(502);
  });
});
