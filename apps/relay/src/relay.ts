/** The Worker's environment: a secret binding and a plain variable. */
export interface Env {
  /** Shared secret callers present in `x-relay-secret` (a Worker secret). */
  RELAY_SECRET: string;
  /** The only host the relay fetches from, for example `<publication>.substack.com` (a Worker var). */
  ALLOWED_HOST: string;
}

export const VERSION = "0.1.0";
/** The relay says what it is; it never pretends to be a browser or another agent. */
export const USER_AGENT = `substacker-relay/${VERSION}`;
/** Largest body passed through. A feed of the latest 20 posts is far below this. */
export const MAX_BODY_BYTES = 10 * 1024 * 1024;
const MAX_HOPS = 5;

const text = (status: number, message: string, extra: Record<string, string> = {}) =>
  new Response(`${message}\n`, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...extra } });

/** Compare two strings without leaking, through timing, how much of them matches. */
export async function secretsMatch(given: string, expected: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(given)), crypto.subtle.digest("SHA-256", enc.encode(expected))]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

function isAllowed(url: URL, allowedHost: string): boolean {
  return url.protocol === "https:" && url.username === "" && url.password === "" && url.host === allowedHost;
}

/** Read a body, giving up as soon as it passes the cap. */
async function readCapped(res: Response): Promise<Uint8Array<ArrayBuffer> | undefined> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    await res.body?.cancel();
    return undefined;
  }
  if (!res.body) return new Uint8Array(new ArrayBuffer(0));
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(new ArrayBuffer(size));
  let offset = 0;
  for (const c of chunks) {
    body.set(c, offset);
    offset += c.byteLength;
  }
  return body;
}

/**
 * Fetch one URL for a caller that presents the shared secret. GET only, https only,
 * the allowed host only (also on every redirect), a capped body, the upstream status
 * and body passed through. `fetchFn` is injected so tests need no network.
 */
export async function handle(request: Request, env: Env, fetchFn: typeof fetch = fetch): Promise<Response> {
  if (!env.RELAY_SECRET || !env.ALLOWED_HOST) return text(500, "relay is not configured");
  const given = request.headers.get("x-relay-secret") ?? "";
  if (!(await secretsMatch(given, env.RELAY_SECRET))) return text(401, "unauthorized");
  if (request.method !== "GET") return text(405, "method not allowed", { allow: "GET" });

  const allowedHost = env.ALLOWED_HOST.toLowerCase();
  const target = new URL(request.url).searchParams.get("url");
  if (!target) return text(400, "missing url parameter");
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return text(400, "invalid url parameter");
  }
  if (url.protocol !== "https:") return text(400, "only https urls are relayed");
  if (!isAllowed(url, allowedHost)) return text(403, "host not allowed");

  try {
    for (let hop = 0; hop <= MAX_HOPS; hop++) {
      const upstream = await fetchFn(url.toString(), {
        method: "GET",
        redirect: "manual",
        headers: { "user-agent": USER_AGENT, accept: "application/rss+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5" },
      });
      if (upstream.status >= 300 && upstream.status < 400) {
        await upstream.body?.cancel();
        const location = upstream.headers.get("location");
        if (!location) return text(502, "redirect without a location");
        const next = new URL(location, url);
        if (!isAllowed(next, allowedHost)) return text(403, "redirect to another host rejected");
        url = next;
        continue;
      }
      const body = await readCapped(upstream);
      if (!body) return text(502, "response too large");
      const headers = new Headers({ "cache-control": "no-store" });
      const type = upstream.headers.get("content-type");
      if (type) headers.set("content-type", type);
      return new Response(body, { status: upstream.status, headers });
    }
    return text(502, "too many redirects");
  } catch {
    return text(502, "upstream fetch failed");
  }
}
