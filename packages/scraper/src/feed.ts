import { createHash } from "node:crypto";
import { XMLParser, XMLValidator } from "fast-xml-parser";

export class FeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeedError";
  }
}

export interface RawItem {
  slug: string;
  /** The `<item>` element exactly as received. */
  raw: string;
}

export interface ItemFields {
  slug: string;
  title: string;
  link: string;
  /** ISO 8601. */
  date: string;
  description: string;
  html: string;
  enclosure: string | null;
}

/** Hash of a raw item, used to detect edits and recorded in each post. */
export function hashRaw(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** Split out each `<item>…</item>` verbatim, skipping over CDATA sections. */
function splitItems(xml: string): string[] {
  const items: string[] = [];
  const open = /<item(?=[\s>/])/g;
  let match: RegExpExecArray | null;
  let from = 0;
  while ((open.lastIndex = from, (match = open.exec(xml)) !== null)) {
    const start = match.index;
    let i = start + match[0].length;
    let end = -1;
    while (i < xml.length) {
      if (xml.startsWith("<![CDATA[", i)) {
        const close = xml.indexOf("]]>", i + 9);
        if (close < 0) break;
        i = close + 3;
      } else if (xml.startsWith("</item>", i)) {
        end = i + "</item>".length;
        break;
      } else {
        i++;
      }
    }
    if (end < 0) throw new FeedError("unterminated <item>");
    items.push(xml.slice(start, end));
    from = end;
  }
  return items;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  processEntities: true,
});

function str(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "#text" in value) return String((value as { "#text": unknown })["#text"]);
  return "";
}

/** The slug of a post link: the segment after `/p/`, decoded. Null if the link is not a post. */
export function slugFromLink(link: string): string | null {
  let pathname: string;
  try {
    pathname = new URL(link).pathname;
  } catch {
    return null;
  }
  const m = /^\/p\/([^/]+)\/?$/.exec(pathname);
  if (!m?.[1]) return null;
  let slug: string;
  try {
    slug = decodeURIComponent(m[1]);
  } catch {
    return null;
  }
  // The slug becomes a file name: refuse anything that could leave its directory.
  if (slug === "." || slug === ".." || /[\\/\0]/.test(slug)) return null;
  return slug;
}

/** Read the fields of one raw item. Throws FeedError if it is not a usable post. */
export function parseItem(raw: string): ItemFields {
  const doc = parser.parse(raw) as { item?: Record<string, unknown> };
  const item = doc.item;
  if (!item || typeof item !== "object") throw new FeedError("not an item");
  const link = str(item["link"]);
  const slug = slugFromLink(link);
  if (!slug) throw new FeedError(`item link is not a post: ${link}`);
  const dateText = str(item["pubDate"]);
  const time = Date.parse(dateText);
  if (Number.isNaN(time)) throw new FeedError(`item ${slug} has no valid pubDate`);
  const enclosure = item["enclosure"] as Record<string, unknown> | undefined;
  const enclosureUrl = enclosure && typeof enclosure["@_url"] === "string" ? enclosure["@_url"] : null;
  const enclosureType = enclosure && typeof enclosure["@_type"] === "string" ? enclosure["@_type"] : "image/";
  return {
    slug,
    title: str(item["title"]),
    link,
    date: new Date(time).toISOString(),
    description: str(item["description"]),
    html: str(item["content:encoded"]),
    enclosure: enclosureUrl && enclosureType.startsWith("image/") ? enclosureUrl : null,
  };
}

export interface ParsedFeed {
  items: RawItem[];
  /** One line for each item that was skipped because it cannot be turned into a post. */
  warnings: string[];
}

/**
 * Items of a feed, each kept exactly as received. Throws FeedError for XML that
 * is not a feed, so a malformed response never overwrites good content. Items
 * whose link is not a `/p/<slug>` post are skipped silently. An item that is a post
 * but that `parseItem` rejects (no valid date, say) is skipped too, with a warning:
 * it is not written to the backup, because the build could not use it.
 */
export function parseFeedDetailed(xml: string): ParsedFeed {
  const valid = XMLValidator.validate(xml);
  if (valid !== true) throw new FeedError(`feed is not well-formed XML: ${valid.err.msg}`);
  if (!/<rss[\s>]/.test(xml) || !/<channel[\s>]/.test(xml)) throw new FeedError("not an RSS feed");
  const items: RawItem[] = [];
  const warnings: string[] = [];
  for (const raw of splitItems(xml)) {
    const link = str((parser.parse(raw) as { item?: Record<string, unknown> }).item?.["link"]);
    const slug = slugFromLink(link);
    if (!slug) continue;
    try {
      parseItem(raw);
    } catch (e) {
      warnings.push(`skipped feed item ${slug}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    items.push({ slug, raw });
  }
  return { items, warnings };
}

/** The usable items of a feed; see `parseFeedDetailed` for the warnings. */
export function parseFeed(xml: string): RawItem[] {
  return parseFeedDetailed(xml).items;
}

/** The feed's own title. */
export function feedTitle(xml: string): string | null {
  const channelStart = xml.search(/<channel[\s>]/);
  const head = channelStart < 0 ? "" : xml.slice(channelStart).split(/<item[\s>]/)[0] ?? "";
  const m = /<title>([\s\S]*?)<\/title>/.exec(head);
  if (!m?.[1]) return null;
  return str((parser.parse(`<t>${m[1]}</t>`) as { t?: unknown }).t) || null;
}
