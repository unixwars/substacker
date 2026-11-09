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

/**
 * Key of an image: a hash of its full address. The local file is
 * `<key>.<extension>`, where the scraper writes the extension it found by looking
 * at the bytes (`sniffImageExtension`). The key needs no content, so a build finds
 * the copy by listing file names, without reading any file.
 */
export function imageKey(url: string): string {
  return hash53(url).toString(16).padStart(14, "0");
}

/** Key to full file name for a listing of image file names. Names without an extension are ignored. */
export function imageFilesByKey(names: Iterable<string>): Map<string, string> {
  const map = new Map<string, string>();
  for (const name of [...names].sort()) {
    const dot = name.indexOf(".");
    if (dot <= 0 || dot === name.length - 1) continue;
    const key = name.slice(0, dot);
    if (!map.has(key)) map.set(key, name);
  }
  return map;
}

const ascii = (b: Uint8Array, start: number, text: string): boolean =>
  b.length >= start + text.length && [...text].every((c, i) => b[start + i] === c.charCodeAt(0));

const HEIC_BRANDS = ["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs"];

function sniffIsoBrand(b: Uint8Array): string | undefined {
  if (!ascii(b, 4, "ftyp")) return undefined;
  const brands: string[] = [];
  for (let i = 8; i + 4 <= Math.min(b.length, 64); i += 4) {
    if (i === 12) continue; // minor version, not a brand
    brands.push(String.fromCharCode(b[i] ?? 0, b[i + 1] ?? 0, b[i + 2] ?? 0, b[i + 3] ?? 0));
  }
  const major = brands[0];
  if (major === "avif" || major === "avis") return "avif";
  if (major !== undefined && HEIC_BRANDS.includes(major)) return "heic";
  if (major === "mif1" || major === "msf1") {
    if (brands.includes("avif") || brands.includes("avis")) return "avif";
    if (brands.some((x) => HEIC_BRANDS.includes(x))) return "heic";
  }
  return undefined;
}

function sniffSvg(b: Uint8Array): boolean {
  let head = "";
  for (let i = 0; i < Math.min(b.length, 4096); i++) head += String.fromCharCode(b[i] ?? 0);
  head = head.replace(/^\u00ef\u00bb\u00bf/, "").trimStart().toLowerCase();
  if (head.startsWith("<svg")) return true;
  return /^(?:<\?xml|<!--|<!doctype svg)/.test(head) && head.includes("<svg");
}

/**
 * The file extension of an image, from its first bytes (magic numbers), or
 * undefined when the bytes are not a recognised image. Pure: no platform `file`.
 */
export function sniffImageExtension(bytes: Uint8Array): string | undefined {
  const b = bytes;
  if (b[0] === 0x89 && ascii(b, 1, "PNG\r\n\x1a\n")) return "png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
  if (ascii(b, 0, "GIF87a") || ascii(b, 0, "GIF89a")) return "gif";
  if (ascii(b, 0, "RIFF") && ascii(b, 8, "WEBP")) return "webp";
  const iso = sniffIsoBrand(b);
  if (iso) return iso;
  if (ascii(b, 0, "BM") && b.length >= 14 && b[6] === 0 && b[7] === 0 && b[8] === 0 && b[9] === 0) return "bmp";
  if (b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0 && ((b[4] ?? 0) > 0 || (b[5] ?? 0) > 0)) return "ico";
  if (sniffSvg(b)) return "svg";
  return undefined;
}

const CONTENT_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/pjpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/heic": "heic",
  "image/heif": "heic",
  "image/svg+xml": "svg",
  "image/bmp": "bmp",
  "image/x-icon": "ico",
  "image/vnd.microsoft.icon": "ico",
};

/** Fallback for `sniffImageExtension`: the extension for a response's Content-Type, if it names an image. */
export function extensionFromContentType(contentType: string | null | undefined): string | undefined {
  const type = contentType?.split(";")[0]?.trim().toLowerCase();
  return type ? CONTENT_TYPES[type] : undefined;
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
