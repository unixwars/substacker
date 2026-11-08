import { lookup as dnsLookup } from "node:dns";
import type { LookupAddress } from "node:dns";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { Readable, pipeline } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { BlockedAddressError, checkUrlShape, isBlockedAddress } from "./address.js";

export type Resolver = (hostname: string) => Promise<LookupAddress[]>;

const systemResolver: Resolver = (hostname) =>
  new Promise((resolve, reject) => dnsLookup(hostname, { all: true, verbatim: true }, (e, addrs) => (e ? reject(e) : resolve(addrs))));

export interface PinnedFetchOptions {
  /** Test and dry-run only; see `Fetcher`. */
  allowPrivate?: boolean;
  /** Replaces the system resolver (tests). */
  resolve?: Resolver;
}

/**
 * A `fetch`-shaped single GET (no redirects followed) over node:http(s). The hostname is
 * resolved once, inside the socket's own `lookup`, every answer is checked, and the
 * connection is made to exactly that address: a second DNS answer cannot swap the target
 * (DNS rebinding). Literal addresses are checked before connecting. Bodies are decompressed
 * here, so the byte cap applies to what is stored.
 */
export function createPinnedFetch(options: PinnedFetchOptions = {}): typeof fetch {
  const resolve = options.resolve ?? systemResolver;
  const impl = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
    new Promise((done, fail) => {
      let url: URL;
      try {
        url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
        checkUrlShape(url, { allowPrivate: options.allowPrivate });
      } catch (e) {
        fail(e);
        return;
      }
      const secure = url.protocol === "https:";
      const hostname = url.hostname.replace(/^\[|\]$/g, "");
      const headers: Record<string, string> = { "accept-encoding": "gzip, deflate, br" };
      new Headers(init?.headers).forEach((v, k) => { headers[k] = v; });
      const lookup = (host: string, opts: { all?: boolean }, cb: (...args: unknown[]) => void) => {
        resolve(host).then(
          (addrs) => {
            const bad = options.allowPrivate ? undefined : addrs.find((a) => isBlockedAddress(a.address));
            if (bad) return cb(new BlockedAddressError(`refused: ${host} resolves to ${bad.address}`));
            if (addrs.length === 0) return cb(new Error(`no address for ${host}`));
            if (opts.all) return cb(null, addrs);
            const first = addrs[0]!;
            cb(null, first.address, first.family);
          },
          (e: unknown) => cb(e),
        );
      };
      const req = (secure ? https : http).request(
        {
          protocol: url.protocol,
          hostname,
          port: url.port || undefined,
          path: `${url.pathname}${url.search}`,
          method: "GET",
          headers,
          agent: false,
          signal: init?.signal ?? undefined,
          ...(isIP(hostname) ? {} : { lookup }),
        } as https.RequestOptions,
        (res) => {
          let stream: Readable = res;
          const enc = String(res.headers["content-encoding"] ?? "").toLowerCase();
          const unzip = enc === "gzip" || enc === "x-gzip" ? createGunzip() : enc === "deflate" ? createInflate() : enc === "br" ? createBrotliDecompress() : undefined;
          if (unzip) stream = pipeline(res, unzip, () => undefined);
          const out = new Headers();
          for (const [k, v] of Object.entries(res.headers)) {
            if (v === undefined || (unzip && (k === "content-encoding" || k === "content-length"))) continue;
            try { for (const one of Array.isArray(v) ? v : [v]) out.append(k, one); } catch { /* skip an invalid header */ }
          }
          const status = res.statusCode ?? 502;
          const empty = status === 204 || status === 205 || status === 304;
          if (empty) res.resume();
          done(new Response(empty ? null : (Readable.toWeb(stream) as ReadableStream<Uint8Array>), { status, statusText: res.statusMessage ?? "", headers: out }));
        },
      );
      req.on("error", fail);
      req.end();
    });
  return impl as typeof fetch;
}
