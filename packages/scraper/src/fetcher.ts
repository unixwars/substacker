import { checkUrlShape } from "./address.js";

export class FetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FetchError";
  }
}

export interface FetcherOptions {
  /** One request, no redirects followed. Production uses the pinned transport in `net.ts`. */
  fetch: typeof fetch;
  /** Test and dry-run only: allow loopback and plain http. Never comes from the user's configuration. */
  allowPrivate?: boolean;
  /** Requests in flight overall (default 4) and per host (default 2, never above the overall limit). */
  maxConcurrent?: number;
  perHost?: number;
  /** Retries after a 429 or 503 (default 3). */
  maxRetries?: number;
  /** Cap on one wait (default 60 s). */
  maxWaitMs?: number;
  /** Base pause between request starts to one host (default 150 ms, plus up to the same again as jitter). */
  hostGapMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
  log?: (message: string) => void;
  userAgent?: string;
}

export interface GetOptions {
  maxBytes: number;
  timeoutMs: number;
  maxRedirects?: number;
  /** Called with each redirect target before it is followed; throw to refuse it. Omit to follow any host. */
  onRedirect?: (next: URL, from: URL) => void;
  /** Do not follow redirects at all: a 3xx is an error. */
  noRedirect?: boolean;
  headers?: Record<string, string>;
}

export interface Fetched {
  status: number;
  headers: Headers;
  body: Uint8Array;
}

const RETRY_STATUS = new Set([429, 503]);

/** Seconds or an HTTP date; undefined if it is neither. */
export function parseRetryAfter(value: string | null, now: number): number | undefined {
  if (!value) return undefined;
  const v = value.trim();
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  const at = Date.parse(v);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

async function readCapped(res: Response, max: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => undefined);
    throw new FetchError("too large");
  }
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw new FetchError("too large");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out;
}

/**
 * Polite, bounded GETs: every hop is checked (scheme, address), redirects are followed by
 * hand, bodies are capped while streaming, requests time out, concurrency is limited overall
 * and per host with a small pause between starts to one host, 429 and 503 are retried
 * (Retry-After honoured, capped) and a host that keeps answering 429 is left alone for the rest of the run.
 */
export class Fetcher {
  private readonly o: Required<Pick<FetcherOptions, "maxConcurrent" | "perHost" | "maxRetries" | "maxWaitMs" | "hostGapMs">> & FetcherOptions;
  private active = 0;
  private readonly activeByHost = new Map<string, number>();
  private readonly nextStart = new Map<string, number>();
  private readonly tripped = new Set<string>();
  private readonly streak429 = new Map<string, number>();
  private waiters: (() => void)[] = [];

  constructor(options: FetcherOptions) {
    const maxConcurrent = options.maxConcurrent ?? 4;
    this.o = {
      ...options,
      maxConcurrent,
      perHost: Math.min(options.perHost ?? 2, maxConcurrent),
      maxRetries: options.maxRetries ?? 3,
      maxWaitMs: options.maxWaitMs ?? 60_000,
      hostGapMs: options.hostGapMs ?? 150,
    };
  }

  private sleep = (ms: number) => (this.o.sleep ?? ((n: number) => new Promise<void>((r) => setTimeout(r, n))))(ms);
  private random = () => (this.o.random ?? Math.random)();
  private now = () => (this.o.now ?? Date.now)();

  isTripped(host: string): boolean {
    return this.tripped.has(host);
  }

  private async acquire(host: string): Promise<void> {
    while (this.active >= this.o.maxConcurrent || (this.activeByHost.get(host) ?? 0) >= this.o.perHost) {
      await new Promise<void>((r) => this.waiters.push(r));
    }
    this.active++;
    this.activeByHost.set(host, (this.activeByHost.get(host) ?? 0) + 1);
  }

  private release(host: string): void {
    this.active--;
    this.activeByHost.set(host, (this.activeByHost.get(host) ?? 1) - 1);
    const waiting = this.waiters;
    this.waiters = [];
    for (const w of waiting) w();
  }

  /** One request, holding a slot, after the pause owed to this host. Reads the body only for a 2xx. */
  private async attempt(url: URL, opts: GetOptions): Promise<Fetched> {
    await this.acquire(url.host);
    try {
      // The host may have been given up on while this request waited for its turn.
      if (this.tripped.has(url.host)) throw new FetchError(`${url.host} is rate limiting us; skipped for this run`);
      const now = this.now();
      const start = Math.max(now, this.nextStart.get(url.host) ?? 0);
      this.nextStart.set(url.host, start + this.o.hostGapMs * (1 + this.random()));
      if (start > now) await this.sleep(start - now);
      const res = await this.o.fetch(url.toString(), {
        redirect: "manual",
        signal: AbortSignal.timeout(opts.timeoutMs),
        headers: { "user-agent": this.o.userAgent ?? "substacker-scraper/0.1 (+https://github.com/unixwars/substacker)", ...opts.headers },
      });
      if (res.status >= 200 && res.status < 300) return { status: res.status, headers: res.headers, body: await readCapped(res, opts.maxBytes) };
      await res.body?.cancel().catch(() => undefined);
      return { status: res.status, headers: res.headers, body: new Uint8Array(0) };
    } finally {
      this.release(url.host);
    }
  }

  private async withRetries(url: URL, opts: GetOptions): Promise<Fetched> {
    if (this.tripped.has(url.host)) throw new FetchError(`${url.host} is rate limiting us; skipped for this run`);
    for (let retry = 0; ; retry++) {
      const res = await this.attempt(url, opts);
      // Answers count per host, not per request: parallel requests to a host that is
      // refusing us must not each spend their own retries before we give up on it.
      const streak = res.status === 429 ? (this.streak429.get(url.host) ?? 0) + 1 : 0;
      this.streak429.set(url.host, streak);
      if (streak > this.o.maxRetries && !this.tripped.has(url.host)) {
        this.tripped.add(url.host);
        this.o.log?.(`${url.host} keeps answering 429; no more requests to it in this run`);
      }
      if (!RETRY_STATUS.has(res.status)) return res;
      if (retry >= this.o.maxRetries || this.tripped.has(url.host)) return res;
      const asked = parseRetryAfter(res.headers.get("retry-after"), this.now());
      const wait = asked ?? Math.min(this.o.maxWaitMs, 2000 * 2 ** retry) * (0.5 + this.random() / 2);
      await this.sleep(Math.min(wait, this.o.maxWaitMs));
    }
  }

  /** GET with checked redirects. Returns the final response whatever its status; throws on policy, size, network and timeout errors. */
  async get(start: string, opts: GetOptions): Promise<Fetched> {
    let url = new URL(start);
    const maxRedirects = opts.maxRedirects ?? 5;
    for (let hop = 0; hop <= maxRedirects; hop++) {
      try {
        checkUrlShape(url, { allowPrivate: this.o.allowPrivate });
      } catch (e) {
        throw new FetchError(e instanceof Error ? e.message : String(e));
      }
      const res = await this.withRetries(url, opts);
      if (res.status < 300 || res.status >= 400) return res;
      if (opts.noRedirect) throw new FetchError(`unexpected redirect from ${url.host}`);
      const location = res.headers.get("location");
      if (!location) throw new FetchError(`redirect without a location from ${url.host}`);
      const next = new URL(location, url);
      opts.onRedirect?.(next, url);
      url = next;
    }
    throw new FetchError("too many redirects");
  }
}
