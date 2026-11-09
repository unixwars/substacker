// Backfill older posts from a Substack data export into the backup layout.
//
// Pure logic only (no file system, no zip library): the script `scripts/backfill-export.mjs`
// reads the zip, and everything it may read is decided here by `classifyEntry`.
//
// Privacy: the export holds subscriber addresses and per-recipient data. Only `posts.csv`
// and `posts/<id>.<slug>.html` are ever opened; every other entry is refused before it is
// inflated, and nothing from the export is written under a name taken from the export.
import { JSDOM } from "jsdom";
import { bodyImageUrls } from "./derive.js";
import { isSafeSlug, parseFeedDetailed } from "./feed.js";
import { stripWidgets } from "./widgets.js";

export class BackfillError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackfillError";
  }
}

/** The element that marks an item synthesized from an export. The feed parser and the build ignore it. */
export const SOURCE_MARKER = "<substacker:source>export</substacker:source>";

/** One entry may inflate to at most this many bytes. */
export const MAX_ENTRY_BYTES = 20 * 1024 * 1024;
/** All entries that are read together may inflate to at most this many bytes. */
export const MAX_TOTAL_BYTES = 200 * 1024 * 1024;

// ---------------------------------------------------------------- CSV (RFC 4180)

/**
 * Rows of a CSV text. Fields may be quoted (commas, doubled quotes and line breaks inside);
 * lines end in LF or CRLF; a leading byte order mark and blank lines are ignored. Errors
 * never repeat the text, since it may be personal data.
 */
export function parseCsv(input: string): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let i = 0;
  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    if (!(row.length === 1 && row[0] === "")) rows.push(row);
    row = [];
  };
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' && field === "") {
      i++;
      for (;;) {
        if (i >= text.length) throw new BackfillError("CSV has an unterminated quoted field");
        if (text[i] === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i += 2;
            continue;
          }
          i++;
          break;
        }
        field += text[i];
        i++;
      }
      const next = text[i];
      if (next !== undefined && next !== "," && next !== "\n" && next !== "\r") throw new BackfillError("CSV has text after a closing quote");
    } else if (ch === '"') {
      throw new BackfillError("CSV has a quote inside an unquoted field");
    } else if (ch === ",") {
      endField();
      i++;
    } else if (ch === "\n" || ch === "\r") {
      endRow();
      i += ch === "\r" && text[i + 1] === "\n" ? 2 : 1;
    } else {
      field += ch;
      i++;
    }
  }
  if (field !== "" || row.length > 0) endRow();
  return rows;
}

export interface PostRow {
  post_id: string;
  post_date: string;
  is_published: string;
  email_sent_at: string;
  inbox_sent_at: string;
  type: string;
  audience: string;
  title: string;
  subtitle: string;
  podcast_url: string;
}

const REQUIRED_COLUMNS = ["post_id", "post_date", "is_published", "type", "audience", "title", "subtitle"] as const;

/** The records of `posts.csv`, keyed by the header. Throws BackfillError if it is not the expected table. */
export function parsePostsCsv(text: string): PostRow[] {
  const [header, ...body] = parseCsv(text);
  if (!header) throw new BackfillError("posts.csv is empty");
  for (const col of REQUIRED_COLUMNS) {
    if (!header.includes(col)) throw new BackfillError(`posts.csv has no ${col} column`);
  }
  return body.map((fields, n) => {
    if (fields.length !== header.length) throw new BackfillError(`posts.csv row ${n + 1} has ${fields.length} fields, expected ${header.length}`);
    const rec: Record<string, string> = {};
    header.forEach((name, k) => (rec[name] = fields[k] ?? ""));
    return {
      email_sent_at: "",
      inbox_sent_at: "",
      podcast_url: "",
      ...rec,
    } as unknown as PostRow;
  });
}

// ---------------------------------------------------------------- what may be read

export type EntryKind = { kind: "posts-csv" } | { kind: "post-html"; id: string; slug: string };

const HTML_ENTRY = /^posts\/(\d+)\.([^/]+)\.html$/;

/**
 * The one place that decides which zip entries may be read: `posts.csv` and
 * `posts/<id>.<slug>.html`, nothing else. Everything else (subscriber lists, per-post
 * delivery and open data, any odd or path-like name) gives null. The returned slug is
 * not yet checked as a file name; see `createEntryFilter` and `selectRows`.
 */
export function classifyEntry(name: string): EntryKind | null {
  // eslint-disable-next-line no-control-regex
  if (name.length === 0 || name.length > 255 || /[\\\u0000-\u001f\u007f]/.test(name)) return null;
  if (name === "posts.csv") return { kind: "posts-csv" };
  const m = HTML_ENTRY.exec(name);
  if (!m?.[1] || !m[2]) return null;
  return { kind: "post-html", id: m[1], slug: m[2] };
}

export interface EntryInfo {
  name: string;
  originalSize: number;
}

export interface EntryFilter {
  /** For `unzipSync(data, { filter })`: true only for entries that may be inflated. */
  filter: (info: EntryInfo) => boolean;
  /** Ids of html entries that match the allowlist but whose slug is not a safe file name; they are not inflated. */
  unsafeIds: Set<string>;
  /** Reasons the export must be refused (size caps, duplicates). Mention ids, never content. */
  problems: string[];
}

/** A filter for one unzip: the allowlist of `classifyEntry` plus the size caps and duplicate checks. */
export function createEntryFilter(): EntryFilter {
  const unsafeIds = new Set<string>();
  const problems: string[] = [];
  const seenIds = new Set<string>();
  let total = 0;
  const filter = (info: EntryInfo): boolean => {
    const entry = classifyEntry(info.name);
    if (!entry) return false;
    const label = entry.kind === "posts-csv" ? "posts.csv" : `the entry of post ${entry.id}`;
    if (entry.kind === "post-html") {
      if (seenIds.has(entry.id)) {
        problems.push(`more than one html entry for post ${entry.id}`);
        return false;
      }
      seenIds.add(entry.id);
      if (!isSafeSlug(entry.slug)) {
        unsafeIds.add(entry.id);
        return false;
      }
    }
    if (info.originalSize > MAX_ENTRY_BYTES) {
      problems.push(`${label} is too large (limit ${MAX_ENTRY_BYTES} bytes)`);
      return false;
    }
    if (total + info.originalSize > MAX_TOTAL_BYTES) {
      problems.push(`the total size of the entries to read exceeds ${MAX_TOTAL_BYTES} bytes (at ${label})`);
      return false;
    }
    total += info.originalSize;
    return true;
  };
  return { filter, unsafeIds, problems };
}

// ---------------------------------------------------------------- selection

export interface Candidate {
  id: string;
  slug: string;
  title: string;
  subtitle: string;
  /** ISO 8601. */
  date: string;
  html: string;
}

export type SkipReason = "invalid-item" | "unpublished" | "not-everyone" | "not-newsletter" | "no-html" | "unsafe-slug" | "bad-date" | "already-present";

export interface Skipped {
  id: string;
  /** Not given for an unpublished row: its slug would name an unpublished post. */
  slug?: string;
  reason: SkipReason;
}

export interface Selection {
  /** Oldest first. */
  add: Candidate[];
  skipped: Skipped[];
}

/**
 * The numeric id of a row. In a real export the `post_id` column holds `<id>.<slug>` (the
 * stem of the html file name) rather than the bare number; both forms are accepted. Only the
 * number is ever reported, since the slug of an unpublished post names it.
 */
export function idOfRow(postId: string): string {
  return /^\d+/.exec(postId.trim())?.[0] ?? postId.trim();
}

/** RFC 822 date in UTC, as the feed writes it, from an ISO date. Null if it is not a date. */
export function pubDateOf(iso: string): string | null {
  if (iso.trim() === "") return null;
  const time = Date.parse(iso);
  return Number.isNaN(time) ? null : new Date(time).toUTCString();
}

/**
 * Decide, for each row of `posts.csv`, whether to add it: published, for everyone, and a
 * newsletter. Every other row is counted with the first reason that applies.
 * `htmlById` holds the html entries read (numeric post id to slug and body), `unsafeIds` the
 * ids whose entry name was refused, `existing` the slugs the backup already holds.
 */
export function selectRows(
  rows: readonly PostRow[],
  htmlById: ReadonlyMap<string, { slug: string; html: string }>,
  unsafeIds: ReadonlySet<string>,
  existing: ReadonlySet<string>,
): Selection {
  const add: Candidate[] = [];
  const skipped: Skipped[] = [];
  const taken = new Set<string>();
  for (const r of rows) {
    const id = idOfRow(r.post_id);
    if (r.is_published.trim().toLowerCase() !== "true") {
      skipped.push({ id, reason: "unpublished" });
      continue;
    }
    const entry = htmlById.get(id);
    const slug = entry?.slug;
    const skip = (reason: SkipReason) => skipped.push(slug === undefined ? { id, reason } : { id, slug, reason });
    if (r.audience !== "everyone") skip("not-everyone");
    else if (r.type !== "newsletter") skip("not-newsletter");
    else if (unsafeIds.has(id)) skip("unsafe-slug");
    else if (!entry) skip("no-html");
    else if (pubDateOf(r.post_date) === null) skip("bad-date");
    else if (existing.has(entry.slug) || taken.has(entry.slug)) skip("already-present");
    else {
      taken.add(entry.slug);
      add.push({ id, slug: entry.slug, title: r.title, subtitle: r.subtitle, date: new Date(Date.parse(r.post_date)).toISOString(), html: entry.html });
    }
  }
  add.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  return { add, skipped };
}

// ---------------------------------------------------------------- the feed item

// Characters XML 1.0 cannot carry, even inside CDATA.
// eslint-disable-next-line no-control-regex
const XML_ILLEGAL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g;

const cdata = (s: string) => `<![CDATA[${s.replace(XML_ILLEGAL, "").replaceAll("]]>", "]]]]><![CDATA[>")}]]>`;
const attr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const IMAGE_TYPES: Record<string, string> = { png: "image/png", gif: "image/gif", webp: "image/webp", avif: "image/avif", svg: "image/svg+xml" };

/** The address behind a `substackcdn.com/image/fetch/<options>/<original>` address, else null. */
function fetchOriginal(address: string): string | null {
  const m = /\/image\/fetch\/(?:[^/]*\/)?(https?(?::|%3A)(?:\/\/|%2F%2F).*)$/i.exec(address);
  if (!m?.[1]) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
}

/** The media type of an image address, guessed from the extension of the original; JPEG by default (what the feed mostly carries). */
function mediaTypeOf(address: string): string {
  let inner = address;
  for (let n = 0; n < 3; n++) inner = fetchOriginal(inner) ?? inner;
  let ext = "";
  try {
    ext = /\.([a-z0-9]+)$/i.exec(new URL(inner).pathname)?.[1]?.toLowerCase() ?? "";
  } catch {
    // not an address; the default applies
  }
  return IMAGE_TYPES[ext] ?? "image/jpeg";
}

/**
 * The cover of the real feed is the post's cover image, which Substack lists as the item's
 * `<enclosure>`. The export carries no such field, so the first image that remains in the body
 * after `stripWidgets` stands in for it: the build already falls back to that image when an
 * item has no enclosure, and listing it as the enclosure also lets `imageUrls` see it. No
 * remote image, no enclosure.
 */
function coverOf(html: string): string | null {
  return bodyImageUrls(stripWidgets(html)).find((u) => /^https?:\/\//i.test(u)) ?? null;
}

/**
 * Synthesize a feed item for a post of an export, shaped like the items of the real feed
 * (see `packages/scraper/test/fixtures/feed.xml`) plus the provenance marker, and return it
 * as `parseFeed` serializes it: that is the text to store. The body is the export's html,
 * unchanged. `origin` is the publication's https origin, the same one the feed's links use.
 */
export function buildBackfillItem(c: Candidate, origin: string): string {
  let base: URL;
  try {
    base = new URL(origin);
  } catch {
    throw new BackfillError("origin is not an address");
  }
  if (base.protocol !== "https:") throw new BackfillError("origin must be an https address");
  if (!isSafeSlug(c.slug)) throw new BackfillError(`post ${c.id}: the slug is not a safe file name`);
  if (!/^\d+$/.test(c.id)) throw new BackfillError("post id is not a number");
  const pubDate = pubDateOf(c.date);
  if (pubDate === null) throw new BackfillError(`post ${c.id}: no valid date`);
  const link = `${base.origin}/p/${encodeURIComponent(c.slug)}`;
  const cover = coverOf(c.html);
  const lines = [
    "<item>",
    `      <title>${cdata(c.title)}</title>`,
    `      <description>${cdata(c.subtitle)}</description>`,
    `      <link>${attr(link)}</link>`,
    `      <guid isPermaLink="false">post:${c.id}</guid>`,
    `      <pubDate>${pubDate}</pubDate>`,
    ...(cover ? [`      <enclosure url="${attr(cover)}" length="0" type="${mediaTypeOf(cover)}"/>`] : []),
    `      ${SOURCE_MARKER}`,
    `      <content:encoded>${cdata(c.html)}</content:encoded>`,
    "    </item>",
  ];
  const wrapped =
    '<?xml version="1.0" encoding="UTF-8"?><rss xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:substacker="urn:substacker:export" version="2.0"><channel><title>x</title>' +
    `${lines.join("\n")}</channel></rss>`;
  let parsed;
  try {
    parsed = parseFeedDetailed(wrapped);
  } catch (e) {
    throw new BackfillError(`post ${c.id}: the item is not accepted by the feed parser: ${e instanceof Error ? e.message : String(e)}`);
  }
  const only = parsed.items[0];
  if (parsed.items.length !== 1 || !only || only.slug !== c.slug) {
    throw new BackfillError(`post ${c.id}: the item does not survive the feed parser${parsed.warnings.length ? ` (${parsed.warnings.join("; ")})` : ""}`);
  }
  return only.raw;
}

// ---------------------------------------------------------------- image hosts

/** Candidate addresses of a srcset value. The address ends at white space, so commas inside it (as in image/fetch options) are kept. */
function srcsetUrls(srcset: string): string[] {
  const urls: string[] = [];
  let i = 0;
  while (i < srcset.length) {
    while (i < srcset.length && /[\s,]/.test(srcset[i] ?? "")) i++;
    const start = i;
    while (i < srcset.length && !/\s/.test(srcset[i] ?? "")) i++;
    let url = srcset.slice(start, i);
    if (url === "") break;
    if (url.endsWith(",")) {
      url = url.replace(/,+$/, "");
    } else {
      // a descriptor follows, up to the next comma
      while (i < srcset.length && srcset[i] !== ",") i++;
    }
    urls.push(url);
  }
  return urls;
}

function hostsOf(address: string): string[] {
  const a = address.trim();
  if (/^data:/i.test(a)) return ["(data)"];
  let url: URL | undefined;
  try {
    url = new URL(a.startsWith("//") ? `https:${a}` : a);
  } catch {
    return ["(relative)"];
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return ["(other)"];
  const hosts = [url.hostname.toLowerCase()];
  let inner = fetchOriginal(a);
  for (let n = 0; inner && n < 3; n++) {
    try {
      hosts.push(new URL(inner).hostname.toLowerCase());
    } catch {
      break;
    }
    inner = fetchOriginal(inner);
  }
  return hosts;
}

/**
 * Hosts of every image address in the given bodies, with how many addresses name each: the
 * `src` of an `<img>`, every candidate of a `srcset` (`<picture>` sources included), and the
 * original inside a `/image/fetch/` address, which counts for its own host as well as the CDN's.
 */
export function countImageHosts(bodies: Iterable<string>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const body of bodies) {
    const doc = new JSDOM(`<!doctype html><body>${body}</body>`).window.document;
    const addresses: string[] = [];
    for (const el of doc.querySelectorAll("img, source")) {
      const src = el.getAttribute("src");
      if (src) addresses.push(src);
      const srcset = el.getAttribute("srcset");
      if (srcset) addresses.push(...srcsetUrls(srcset));
    }
    for (const address of addresses) {
      for (const host of hostsOf(address)) counts.set(host, (counts.get(host) ?? 0) + 1);
    }
  }
  return counts;
}

/** Host counts, most addresses first, then by name. */
export function sortedHosts(counts: ReadonlyMap<string, number>): [string, number][] {
  return [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}
