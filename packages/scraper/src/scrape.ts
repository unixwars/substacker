import { extensionFromContentType, imageKey, sniffImageExtension } from "substacker-core";
import type { Config } from "./config.js";
import { imageUrls } from "./derive.js";
import { FeedError, parseFeedDetailed } from "./feed.js";
import { Fetcher } from "./fetcher.js";
import type { Fetched } from "./fetcher.js";
import { sanitizeSvg } from "./svg.js";

export type Change =
  | { kind: "raw"; slug: string; content: string }
  /** `name` is `<key>.<extension>`; the extension comes from the bytes, never from the address. */
  | { kind: "image"; name: string; data: Uint8Array };

/** What the scraper may read of the existing backup. It never writes. */
export interface BackupReader {
  /** Slugs of every stored raw item. */
  slugs(): string[];
  readRaw(slug: string): string | undefined;
  /** Whether a file for this image key (`<key>.<any extension>`) is already stored. */
  hasImage(key: string): boolean;
}

export interface ScrapeDeps {
  /** One GET without following redirects; the CLI passes the pinned transport (`createPinnedFetch`). */
  fetch: typeof fetch;
  backup: BackupReader;
  env?: Record<string, string | undefined>;
  log?: (message: string) => void;
  /** Test and dry-run only: allow loopback and plain http. Never set from the user's configuration. */
  allowPrivate?: boolean;
  /** Replace the clock and the pauses (tests); by default real time. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
}

export class ScrapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScrapeError";
  }
}

const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
const MAX_FEED_BYTES = 10 * 1024 * 1024;
const TIMEOUT_MS = 30_000;
const DEFAULT_DOWNLOADS = 4;

function makeFetcher(config: Config, deps: ScrapeDeps): Fetcher {
  return new Fetcher({
    fetch: deps.fetch,
    allowPrivate: deps.allowPrivate,
    maxConcurrent: config.maxConcurrentDownloads ?? DEFAULT_DOWNLOADS,
    sleep: deps.sleep,
    random: deps.random,
    now: deps.now,
    log: deps.log,
  });
}

function httpFailure(what: string, status: number): ScrapeError {
  const retried = status === 429 || status === 503 ? " (still busy after the retries)" : "";
  return new ScrapeError(`${what} failed: HTTP ${status}${retried}`);
}

async function fetchFeedText(config: Config, deps: ScrapeDeps, fetcher: Fetcher): Promise<string> {
  let res: Fetched;
  try {
    if (config.relayUrl) {
      const secret = deps.env?.["SUBSTACKER_RELAY_SECRET"];
      if (!secret) throw new ScrapeError("relayUrl is set but SUBSTACKER_RELAY_SECRET is not");
      const target = new URL(config.relayUrl);
      target.searchParams.set("url", config.feedUrl);
      res = await fetcher.get(target.toString(), { maxBytes: MAX_FEED_BYTES, timeoutMs: TIMEOUT_MS, noRedirect: true, headers: { "x-relay-secret": secret } });
    } else {
      const host = new URL(config.feedUrl).host;
      res = await fetcher.get(config.feedUrl, {
        maxBytes: MAX_FEED_BYTES,
        timeoutMs: TIMEOUT_MS,
        onRedirect: (next) => {
          if (next.host !== host) throw new ScrapeError(`feed redirected to another host (${next.host}); aborting`);
        },
      });
    }
  } catch (e) {
    if (e instanceof ScrapeError) throw e;
    throw new ScrapeError(`feed fetch failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (res.status === 403 && !config.relayUrl) {
    throw new ScrapeError(
      "feed fetch failed: HTTP 403. The publication refuses this network (GitHub's runners are often blocked). Deploy the relay and set relayUrl in the configuration; see docs/setup.md.",
    );
  }
  if (res.status < 200 || res.status >= 300) throw httpFailure("feed fetch", res.status);
  return new TextDecoder().decode(res.body);
}

/**
 * Download an image and name its extension from its bytes, else from the response's
 * Content-Type. If neither says it is an image (a blocking page served with 200, say),
 * it fails and is retried on the next run; nothing is ever stored as `.bin`. An SVG is
 * sanitized first and fails if nothing valid is left.
 */
async function downloadImage(fetcher: Fetcher, url: string): Promise<{ data: Uint8Array; ext: string }> {
  const res = await fetcher.get(url, { maxBytes: MAX_IMAGE_BYTES, timeoutMs: TIMEOUT_MS });
  if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`);
  if (res.body.byteLength === 0) throw new Error("empty body");
  const ext = sniffImageExtension(res.body) ?? extensionFromContentType(res.headers.get("content-type"));
  if (!ext) throw new Error("not a recognised image");
  if (ext !== "svg") return { data: res.body, ext };
  const safe = sanitizeSvg(res.body);
  if (!safe) throw new Error("svg has nothing valid left after sanitizing");
  return { data: safe, ext };
}

/**
 * Compare the feed with the backup and return what to write: new or edited raw
 * items, and every image still missing for any stored item. Writes nothing; any
 * feed failure throws and returns no changes. Never deletes.
 */
export async function scrape(config: Config, deps: ScrapeDeps): Promise<Change[]> {
  const log = deps.log ?? (() => undefined);
  const fetcher = makeFetcher(config, deps);
  const xml = await fetchFeedText(config, deps, fetcher);
  let items;
  try {
    const parsed = parseFeedDetailed(xml);
    items = parsed.items;
    for (const w of parsed.warnings) log(w);
  } catch (e) {
    if (e instanceof FeedError) throw new ScrapeError(e.message);
    throw e;
  }

  const changes: Change[] = [];
  const current = new Map<string, string>();
  for (const slug of deps.backup.slugs()) {
    const raw = deps.backup.readRaw(slug);
    if (raw !== undefined) current.set(slug, raw);
  }
  for (const { slug, raw } of items) {
    if (current.get(slug) !== raw) {
      changes.push({ kind: "raw", slug, content: raw });
      current.set(slug, raw);
    }
  }

  const wanted = new Set<string>();
  for (const raw of current.values()) {
    try {
      for (const url of imageUrls(raw)) wanted.add(url);
    } catch (e) {
      log(`skipping images of an unreadable item: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const done = new Set<string>();
  const todo: { url: string; key: string }[] = [];
  for (const url of [...wanted].sort()) {
    const key = imageKey(url);
    if (done.has(key) || deps.backup.hasImage(key)) continue;
    done.add(key);
    todo.push({ url, key });
  }
  // Requests run together within the fetcher's limits; the results are applied in address order.
  const results = await Promise.all(
    todo.map(async ({ url, key }) => {
      try {
        const { data, ext } = await downloadImage(fetcher, url);
        return { kind: "image", name: `${key}.${ext}`, data } satisfies Change;
      } catch (e) {
        log(`image not downloaded, will retry next run: ${url} (${e instanceof Error ? e.message : String(e)})`);
        return undefined;
      }
    }),
  );
  for (const r of results) if (r) changes.push(r);
  return changes;
}
