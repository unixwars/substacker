import { JSDOM } from "jsdom";
import { CONTRACT_VERSION, canonicalUrl, imageName, parsePost } from "substacker-core";
import type { Doc, Entry, Index, Post, SanitizePolicy } from "substacker-core";
import { sanitizeHtml } from "substacker-core/dom";
import type { DomParser } from "substacker-core/dom";
import { hashRaw, parseItem } from "./feed.js";
import { jsdomWindow, textOf } from "./html.js";
import { stripWidgets } from "./widgets.js";

export interface DeriveOptions {
  /** Window the sanitizer runs in. Defaults to jsdom. */
  domParser?: DomParser;
  /** Sanitizer policy. Defaults to core's. */
  policy?: SanitizePolicy;
}

function bodyImageUrls(strippedHtml: string): string[] {
  const doc = new JSDOM(`<!doctype html><body>${strippedHtml}</body>`).window.document;
  return [...doc.querySelectorAll("img[src]")].map((img) => img.getAttribute("src") ?? "").filter(Boolean);
}

const unique = <T>(xs: T[]) => [...new Set(xs)];
const isRemote = (url: string) => /^https?:\/\//i.test(url);

/**
 * Every image address a raw item needs a local copy of: the images that remain in
 * the post body (one candidate per `<picture>`) and the cover from the feed's
 * enclosure. Only http(s) addresses are returned.
 */
export function imageUrls(raw: string): string[] {
  const item = parseItem(raw);
  const urls = bodyImageUrls(stripWidgets(item.html));
  if (item.enclosure) urls.push(item.enclosure);
  return unique(urls.filter(isRemote));
}

function excerptOf(description: string, bodyHtml: string): string {
  const source = textOf(description) || textOf(bodyHtml);
  if (source.length <= 200) return source;
  const cut = source.slice(0, 200);
  const space = cut.lastIndexOf(" ");
  return `${(space > 100 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * Build the served post from a raw item. An image whose local copy is in `present`
 * (a set of `imageName` values) is pointed at `images/<name>`; any other keeps its
 * original address and is counted in `unlocalized`.
 */
export function derivePost(raw: string, present: ReadonlySet<string>, opts: DeriveOptions = {}): Post {
  const item = parseItem(raw);
  const stripped = stripWidgets(item.html);
  const missing = new Set<string>();

  const localize = (url: string): string => {
    if (!isRemote(url)) return url;
    const name = imageName(url);
    if (present.has(name)) return `images/${name}`;
    missing.add(url);
    return url;
  };

  const doc = new JSDOM(`<!doctype html><body>${stripped}</body>`).window.document;
  for (const img of doc.querySelectorAll("img[src]")) {
    img.setAttribute("src", localize(img.getAttribute("src") ?? ""));
  }
  const firstImage = doc.querySelector("img[src]")?.getAttribute("src") ?? null;

  let cover: string | null = null;
  if (item.enclosure) cover = localize(item.enclosure);
  else if (firstImage) cover = firstImage;

  const html = sanitizeHtml(doc.body.innerHTML, opts.domParser ?? jsdomWindow, opts.policy);

  return parsePost({
    version: CONTRACT_VERSION,
    slug: item.slug,
    title: item.title,
    date: item.date,
    excerpt: excerptOf(item.description, stripped),
    cover,
    html,
    sourceUrl: canonicalUrl(item.link),
    contentHash: hashRaw(raw),
    unlocalized: missing.size,
  });
}

export interface BuiltIndex {
  index: Index;
  docs: Doc[];
  /** Hidden slugs that match no stored post. */
  warnings: string[];
}

/**
 * The index and the search documents for the visible posts, newest first. A hidden
 * slug is left out of both. If two posts share a slug the first one given wins.
 */
export function buildIndex(posts: readonly Post[], hidden: readonly string[], feedName: string): BuiltIndex {
  const hiddenSet = new Set(hidden);
  const seen = new Set<string>();
  const unique: Post[] = [];
  for (const p of posts) {
    if (seen.has(p.slug)) continue;
    seen.add(p.slug);
    unique.push(p);
  }
  const visible = unique
    .filter((p) => !hiddenSet.has(p.slug))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  const entries: Entry[] = visible.map((p) => ({ slug: p.slug, title: p.title, date: p.date, excerpt: p.excerpt, cover: p.cover }));
  return {
    index: { version: CONTRACT_VERSION, title: feedName, posts: entries },
    docs: visible.map((p) => ({ slug: p.slug, title: p.title, text: textOf(p.html) })),
    warnings: hidden.filter((s) => !seen.has(s)).map((s) => `hidden slug matches no stored post: ${s}`),
  };
}
