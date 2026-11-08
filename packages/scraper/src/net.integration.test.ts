import { gzipSync } from "node:zlib";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Fetcher } from "./fetcher.js";
import { createPinnedFetch } from "./net.js";

let server: Server;
let port = 0;
let hits = 0;
beforeAll(async () => {
  server = createServer((req, res) => {
    hits++;
    if (req.url === "/gz") res.writeHead(200, { "content-encoding": "gzip" }).end(gzipSync("hello"));
    else if (req.url === "/redir") res.writeHead(302, { location: "/gz" }).end();
    else if (req.url === "/hang") return;
    else if (req.url === "/huge") {
      res.writeHead(200);
      const t = setInterval(() => res.write(Buffer.alloc(64 * 1024)), 1);
      res.on("close", () => clearInterval(t));
    } else res.writeHead(200, { "content-type": "text/plain" }).end("plain");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));

const GET = { maxBytes: 1_000_000, timeoutMs: 2000 };
const text = (b: Uint8Array) => new TextDecoder().decode(b);

describe("pinned transport", () => {
  it("fetches, decompresses and reports redirects without following them", async () => {
    const f = createPinnedFetch({ allowPrivate: true });
    const r = await f(`http://127.0.0.1:${port}/redir`, { redirect: "manual" });
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/gz");
    await r.body?.cancel();
    const fetcher = new Fetcher({ fetch: f, allowPrivate: true, hostGapMs: 0 });
    expect(text((await fetcher.get(`http://127.0.0.1:${port}/redir`, GET)).body)).toBe("hello");
  });
  it("refuses loopback by default, by address and by name, before any connection", async () => {
    hits = 0;
    const f = createPinnedFetch();
    await expect(f(`http://127.0.0.1:${port}/`)).rejects.toThrow();
    await expect(f(`https://127.0.0.1:${port}/`)).rejects.toThrow(/private|loopback/);
    await expect(f(`https://localhost:${port}/`)).rejects.toThrow();
    expect(hits).toBe(0);
  });
  it("refuses a name that resolves to a private address, and connects to the checked address only", async () => {
    hits = 0;
    const resolve = async () => [{ address: "10.0.0.5", family: 4 }];
    await expect(createPinnedFetch({ resolve })(`https://rebind.example.test/`)).rejects.toThrow(/resolves to 10\.0\.0\.5/);
    const mixed = async () => [{ address: "93.184.216.34", family: 4 }, { address: "127.0.0.1", family: 4 }];
    await expect(createPinnedFetch({ resolve: mixed })(`https://mixed.example.test/`)).rejects.toThrow(/resolves to 127\.0\.0\.1/);
    // A name that resolves to the local test server is reached only through the resolver's answer.
    let lookups = 0;
    const pinned = async () => (lookups++, [{ address: "127.0.0.1", family: 4 }]);
    const r = await createPinnedFetch({ allowPrivate: true, resolve: pinned })(`http://anything.example.test:${port}/`);
    expect(text(new Uint8Array(await r.arrayBuffer()))).toBe("plain");
    expect(lookups).toBe(1);
    expect(hits).toBe(1);
  });
  it("times out a server that never answers", async () => {
    const fetcher = new Fetcher({ fetch: createPinnedFetch({ allowPrivate: true }), allowPrivate: true });
    await expect(fetcher.get(`http://127.0.0.1:${port}/hang`, { ...GET, timeoutMs: 150 })).rejects.toThrow();
  });
  it("cuts off an endless body at the cap", async () => {
    const fetcher = new Fetcher({ fetch: createPinnedFetch({ allowPrivate: true }), allowPrivate: true });
    await expect(fetcher.get(`http://127.0.0.1:${port}/huge`, { maxBytes: 200_000, timeoutMs: 5000 })).rejects.toThrow(/too large/);
  });
});
