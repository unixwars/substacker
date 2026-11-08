import { extensionFromContentType, imageKey, sniffImageExtension } from "substacker-core";
import type { Config } from "./config.js";
import { imageUrls } from "./derive.js";
import { FeedError, parseFeedDetailed } from "./feed.js";

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
  fetch: typeof fetch;
  backup: BackupReader;
  env?: Record<string, string | undefined>;
  log?: (message: string) => void;
}

export class ScrapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScrapeError";
  }
}

const MAX_HOPS = 5;
const MAX_IMAGE_BYTES = 50 * 1024 * 1024;

/** GET following redirects by hand, refusing any hop that leaves `host`. */
async function getWithinHost(fetchFn: typeof fetch, start: string, host: string): Promise<Response> {
  let url = start;
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    const res = await fetchFn(url, { redirect: "manual" });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) throw new ScrapeError(`redirect without a location from ${url}`);
      const next = new URL(location, url);
      if (next.host !== host) throw new ScrapeError(`feed redirected to another host (${next.host}); aborting`);
      url = next.toString();
      continue;
    }
    return res;
  }
  throw new ScrapeError("too many redirects");
}

async function fetchFeedText(config: Config, deps: ScrapeDeps): Promise<string> {
  let res: Response;
  try {
    if (config.relayUrl) {
      const secret = deps.env?.["SUBSTACKER_RELAY_SECRET"];
      if (!secret) throw new ScrapeError("relayUrl is set but SUBSTACKER_RELAY_SECRET is not");
      const target = new URL(config.relayUrl);
      target.searchParams.set("url", config.feedUrl);
      res = await deps.fetch(target.toString(), { headers: { "x-relay-secret": secret } });
    } else {
      res = await getWithinHost(deps.fetch, config.feedUrl, new URL(config.feedUrl).host);
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
  if (!res.ok) throw new ScrapeError(`feed fetch failed: HTTP ${res.status}`);
  return res.text();
}

/**
 * Download an image and name its extension from its bytes, else from the response's
 * Content-Type. If neither says it is an image (a blocking page served with 200, say),
 * it fails and is retried on the next run; nothing is ever stored as `.bin`.
 */
async function downloadImage(fetchFn: typeof fetch, url: string): Promise<{ data: Uint8Array; ext: string }> {
  const res = await fetchFn(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = new Uint8Array(await res.arrayBuffer());
  if (data.byteLength === 0) throw new Error("empty body");
  if (data.byteLength > MAX_IMAGE_BYTES) throw new Error("too large");
  const ext = sniffImageExtension(data) ?? extensionFromContentType(res.headers.get("content-type"));
  if (!ext) throw new Error("not a recognised image");
  return { data, ext };
}

/**
 * Compare the feed with the backup and return what to write: new or edited raw
 * items, and every image still missing for any stored item. Writes nothing; any
 * feed failure throws and returns no changes. Never deletes.
 */
export async function scrape(config: Config, deps: ScrapeDeps): Promise<Change[]> {
  const log = deps.log ?? (() => undefined);
  const xml = await fetchFeedText(config, deps);
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
  for (const url of [...wanted].sort()) {
    const key = imageKey(url);
    if (done.has(key) || deps.backup.hasImage(key)) continue;
    done.add(key);
    try {
      const { data, ext } = await downloadImage(deps.fetch, url);
      changes.push({ kind: "image", name: `${key}.${ext}`, data });
    } catch (e) {
      log(`image not downloaded, will retry next run: ${url} (${e instanceof Error ? e.message : String(e)})`);
    }
  }
  return changes;
}
