import type { Entry } from "./contract.js";

/** The index is newest first, so `next` is the older post. */
export function neighbours(index: { posts: readonly Entry[] }, slug: string): { previous?: Entry; next?: Entry } {
  const i = index.posts.findIndex((p) => p.slug === slug);
  if (i < 0) return {};
  const result: { previous?: Entry; next?: Entry } = {};
  const previous = index.posts[i - 1];
  const next = index.posts[i + 1];
  if (previous) result.previous = previous;
  if (next) result.next = next;
  return result;
}

/** A link without its query and hash. */
export function canonicalUrl(link: string): string {
  try {
    const url = new URL(link);
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return link.split("#")[0]?.split("?")[0] ?? link;
  }
}

/**
 * Mark an outbound link to Substack as coming from this reader. The feed's own
 * `utm_*` values (which would label our readers as email) are replaced.
 */
export function outboundUrl(url: string, opts: { utmSource: string; action?: "share" }): string {
  const u = new URL(url);
  for (const key of [...u.searchParams.keys()]) {
    if (key.startsWith("utm_")) u.searchParams.delete(key);
  }
  u.searchParams.set("utm_source", opts.utmSource);
  u.searchParams.set("utm_medium", "reader");
  if (opts.action) u.searchParams.set("action", opts.action);
  return u.toString();
}

export type DockAction = "comment" | "share";

/** Links for the configured actions, in the order given, each kind once. */
export function dockLinks(
  post: { sourceUrl: string },
  actions: readonly DockAction[],
  utmSource: string,
): { kind: DockAction; href: string }[] {
  const links: { kind: DockAction; href: string }[] = [];
  for (const kind of new Set(actions)) {
    if (kind === "comment") {
      links.push({ kind, href: outboundUrl(`${post.sourceUrl.replace(/\/+$/, "")}/comments`, { utmSource }) });
    } else {
      links.push({ kind, href: outboundUrl(post.sourceUrl, { utmSource, action: "share" }) });
    }
  }
  return links;
}

/** cyrb53: a fast, well-distributed 53-bit string hash with no platform dependency. */
function hash53(str: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

const IMAGE_EXTENSION = /\.(avif|gif|jpe?g|png|svg|webp)$/i;

/**
 * Local file name of an image: a hash of its full address plus the extension of
 * the underlying image (`bin` when there is none). The scraper and the build both
 * use it, so a copy is found by name without reading any file.
 */
export function imageName(url: string): string {
  let path = url.split(/[?#]/)[0] ?? url;
  try {
    path = decodeURIComponent(path);
  } catch {
    // keep the raw path
  }
  const ext = IMAGE_EXTENSION.exec(path)?.[1]?.toLowerCase() ?? "bin";
  return `${hash53(url).toString(16).padStart(14, "0")}.${ext}`;
}

const ABSOLUTE = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

/** Make a path relative to the served content root absolute against `base`. */
export function resolveAsset(path: string, base: string): string {
  if (ABSOLUTE.test(path)) return path;
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\.?\/+/, "")}`;
}

/** Rewrite relative `<img src>` values in sanitized HTML. Pure string work: no DOM needed. */
export function resolveAssets(html: string, base: string): string {
  return html.replace(/<img\b[^>]*>/gi, (tag) =>
    tag.replace(/(\ssrc=)(["'])(.*?)\2/i, (_m, pre: string, q: string, value: string) => `${pre}${q}${resolveAsset(value, base)}${q}`),
  );
}
