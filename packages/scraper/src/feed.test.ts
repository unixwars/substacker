import { describe, expect, it } from "vitest";
import { FeedError, feedTitle, hashRaw, isSafeSlug, parseFeed, parseFeedDetailed, parseItem, slugFromLink } from "./feed.js";
import { feedXml, fixtureFeed } from "./test-support/feeds.js";

describe("parseFeed", () => {
  it("returns every item with its slug, exactly as received", () => {
    const items = parseFeed(fixtureFeed);
    expect(items.map((i) => i.slug)).toEqual(["hello-world", "second-post", "just-text"]);
    for (const { raw } of items) {
      expect(fixtureFeed).toContain(raw);
      expect(raw.startsWith("<item>")).toBe(true);
      expect(raw.endsWith("</item>")).toBe(true);
    }
  });
  it("handles a feed with no items", () => {
    expect(parseFeed(feedXml([]))).toEqual([]);
  });
  it("handles a feed with one item", () => {
    expect(parseFeed(feedXml([{ title: "One", link: "https://example.substack.com/p/one" }])).map((i) => i.slug)).toEqual(["one"]);
  });
  it("derives a non-ASCII slug from the link", () => {
    const [item] = parseFeed(feedXml([{ title: "Café", link: "https://example.substack.com/p/caf%C3%A9-%E6%97%A5%E6%9C%AC" }]));
    expect(item?.slug).toBe("café-日本");
  });
  it("skips items that are not posts", () => {
    const xml = feedXml([
      { title: "Page", link: "https://example.substack.com/about" },
      { title: "Post", link: "https://example.substack.com/p/real" },
    ]);
    expect(parseFeed(xml).map((i) => i.slug)).toEqual(["real"]);
  });
  it("does not split on an item end tag inside CDATA", () => {
    const xml = feedXml([{ title: "T", link: "https://example.substack.com/p/tricky", body: "<p>a &lt;/item&gt; b</p><pre>&lt;/item&gt;</pre>" }]).replace(
      "<p>a &lt;/item&gt; b</p>",
      "<p>a </item> b</p>",
    );
    const [item] = parseFeed(xml);
    expect(item?.raw).toContain("<p>a </item> b</p>");
    expect(parseItem(item?.raw ?? "").html).toContain("a </item> b");
  });
  it.each(["", "not xml at all", "<rss><channel><item></rss>", "<html><body>hi</body></html>", "<rss><channel>"])(
    "rejects %j",
    (xml) => {
      expect(() => parseFeed(xml)).toThrow(FeedError);
    },
  );
  it("refuses a slug that could leave its directory", () => {
    expect(slugFromLink("https://example.substack.com/p/..%2Fescape")).toBeNull();
    expect(slugFromLink("https://example.substack.com/p/..")).toBeNull();
    expect(slugFromLink("https://example.substack.com/p/a/b")).toBeNull();
    expect(slugFromLink("https://example.substack.com/p/ok/")).toBe("ok");
  });
});

describe("parseFeedDetailed", () => {
  const badFeed = feedXml([
    { title: "Good", link: "https://example.substack.com/p/good" },
    { title: "No date", link: "https://example.substack.com/p/nodate", pubDate: "" },
    { title: "Bad date", link: "https://example.substack.com/p/baddate", pubDate: "last tuesday" },
  ]);
  it("skips an item that build could not derive and says why", () => {
    const { items, warnings } = parseFeedDetailed(badFeed);
    expect(items.map((i) => i.slug)).toEqual(["good"]);
    expect(warnings).toHaveLength(2);
    expect(warnings.join("\n")).toMatch(/nodate/);
    expect(warnings.join("\n")).toMatch(/baddate/);
  });
  it("parseFeed returns the same usable items", () => {
    expect(parseFeed(badFeed).map((i) => i.slug)).toEqual(["good"]);
  });
  it("gives no warning for a clean feed or for a link that is not a post", () => {
    expect(parseFeedDetailed(fixtureFeed).warnings).toEqual([]);
    expect(parseFeedDetailed(feedXml([{ title: "Page", link: "https://example.substack.com/about" }])).warnings).toEqual([]);
  });
});

describe("parseItem", () => {
  const [first] = parseFeed(fixtureFeed);
  it("reads the fields", () => {
    const item = parseItem(first?.raw ?? "");
    expect(item.slug).toBe("hello-world");
    expect(item.title).toBe("Hello, world");
    expect(item.date).toBe("2026-03-02T10:00:00.000Z");
    expect(item.link).toBe("https://example.substack.com/p/hello-world?utm_source=substack&utm_medium=email");
    expect(item.description).toBe("A placeholder subtitle.");
    expect(item.html).toContain("<picture>");
    expect(item.enclosure).toContain("substackcdn.com/image/fetch/");
  });
  it("rejects an item without a valid date", () => {
    const raw = "<item><title>T</title><link>https://example.substack.com/p/x</link><pubDate>never</pubDate></item>";
    expect(() => parseItem(raw)).toThrow(FeedError);
  });
});

describe("hashRaw and feedTitle", () => {
  it("hashes differently when the item differs", () => {
    expect(hashRaw("a")).not.toBe(hashRaw("b"));
    expect(hashRaw("a")).toBe(hashRaw("a"));
    expect(hashRaw("a")).toMatch(/^[0-9a-f]{64}$/);
  });
  it("reads the channel title, not an item's", () => {
    expect(feedTitle(fixtureFeed)).toBe("Example Newsletter");
    expect(feedTitle(feedXml([], "Other"))).toBe("Other");
  });
});

describe("isSafeSlug", () => {
  it("accepts ordinary and non-ASCII slugs", () => {
    expect(isSafeSlug("hello-world")).toBe(true);
    expect(isSafeSlug("café")).toBe(true);
    expect(isSafeSlug("a.b")).toBe(true);
  });
  it("refuses empty, dot names, separators and NUL", () => {
    for (const s of ["", ".", "..", "a/b", "a\\b", "a\0b"]) expect(isSafeSlug(s), s).toBe(false);
  });
});
