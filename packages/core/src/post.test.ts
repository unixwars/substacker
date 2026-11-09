import { describe, expect, it } from "vitest";
import type { Entry } from "./contract.js";
import {
  canonicalUrl,
  dockLinks,
  extensionFromContentType,
  imageFilesByKey,
  imageKey,
  neighbours,
  outboundUrl,
  resolveAsset,
  resolveAssets,
  sniffImageExtension,
} from "./post.js";

const e = (slug: string): Entry => ({ slug, title: slug, date: "2026-01-01T00:00:00Z", excerpt: "", cover: null });
const index = { posts: [e("c"), e("b"), e("a")] }; // newest first

describe("neighbours", () => {
  it("returns the newer post as previous and the older as next", () => {
    expect(neighbours(index, "b")).toEqual({ previous: e("c"), next: e("a") });
  });
  it("has no previous for the newest and no next for the oldest", () => {
    expect(neighbours(index, "c")).toEqual({ next: e("b") });
    expect(neighbours(index, "a")).toEqual({ previous: e("b") });
  });
  it("returns nothing for an unknown slug or a single post", () => {
    expect(neighbours(index, "zzz")).toEqual({});
    expect(neighbours({ posts: [e("a")] }, "a")).toEqual({});
    expect(neighbours({ posts: [] }, "a")).toEqual({});
  });
});

describe("canonicalUrl", () => {
  it("drops query and hash", () => {
    expect(canonicalUrl("https://example.substack.com/p/hello?utm_source=substack&utm_medium=email#top")).toBe(
      "https://example.substack.com/p/hello",
    );
  });
  it("leaves a clean link alone", () => {
    expect(canonicalUrl("https://example.substack.com/p/hello")).toBe("https://example.substack.com/p/hello");
  });
  it("copes with something that is not a URL", () => {
    expect(canonicalUrl("/p/hello?x=1#y")).toBe("/p/hello");
  });
});

describe("outboundUrl", () => {
  const opts = { utmSource: "substacker" };
  it("sets our utm_source and utm_medium", () => {
    expect(outboundUrl("https://example.substack.com/p/hello", opts)).toBe(
      "https://example.substack.com/p/hello?utm_source=substacker&utm_medium=reader",
    );
  });
  it("replaces the feed's own utm values and keeps other parameters", () => {
    expect(
      outboundUrl("https://example.substack.com/p/hello?utm_source=substack&utm_medium=email&utm_campaign=x&ref=1", opts),
    ).toBe("https://example.substack.com/p/hello?ref=1&utm_source=substacker&utm_medium=reader");
  });
  it("adds action=share", () => {
    expect(outboundUrl("https://example.substack.com/p/hello", { ...opts, action: "share" })).toBe(
      "https://example.substack.com/p/hello?utm_source=substacker&utm_medium=reader&action=share",
    );
  });
  it("encodes the source label", () => {
    expect(outboundUrl("https://example.substack.com/p/x", { utmSource: "my reader" })).toContain("utm_source=my+reader");
  });
});

describe("dockLinks", () => {
  const post = { sourceUrl: "https://example.substack.com/p/hello" };
  it("is empty without actions", () => {
    expect(dockLinks(post, [], "substacker")).toEqual([]);
  });
  it("builds comment and share links with our utm values, in the order given", () => {
    expect(dockLinks(post, ["share", "comment"], "substacker")).toEqual([
      { kind: "share", href: "https://example.substack.com/p/hello?utm_source=substacker&utm_medium=reader&action=share" },
      { kind: "comment", href: "https://example.substack.com/p/hello/comments?utm_source=substacker&utm_medium=reader" },
    ]);
  });
  it("lists a repeated action once", () => {
    expect(dockLinks(post, ["comment", "comment"], "s")).toHaveLength(1);
  });
});

describe("imageKey", () => {
  const cdn =
    "https://substackcdn.com/image/fetch/$s_!abcd!,w_1456,c_limit,f_auto/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F1111_1200x800.jpeg";
  it("is stable for the same address and has no extension", () => {
    expect(imageKey(cdn)).toBe(imageKey(cdn));
    expect(imageKey(cdn)).toMatch(/^[0-9a-f]{14}$/);
  });
  it("differs for different addresses, including the query", () => {
    expect(imageKey("https://example.com/a.jpg?w=1")).not.toBe(imageKey("https://example.com/a.jpg?w=2"));
    expect(imageKey("https://example.com/a.jpg")).not.toBe(imageKey("https://example.com/b.jpg"));
  });
  it("has a pinned value, so the scraper and every build agree across versions", () => {
    expect(imageKey("https://example.com/a.jpg")).toBe("026d71faef9eb9");
  });
});

describe("imageFilesByKey", () => {
  it("maps each key to its full file name, whatever the extension", () => {
    const map = imageFilesByKey(["026d71faef9eb9.png", "ffffffffffffff.webp"]);
    expect(map.get("026d71faef9eb9")).toBe("026d71faef9eb9.png");
    expect(map.get("ffffffffffffff")).toBe("ffffffffffffff.webp");
    expect(map.get("000000000000aa")).toBeUndefined();
  });
  it("is deterministic when a key has two files, and ignores names without an extension", () => {
    expect(imageFilesByKey(["aa.webp", "aa.png"]).get("aa")).toBe("aa.png");
    expect(imageFilesByKey(["noext"]).size).toBe(0);
  });
});

const bytes = (...xs: (number | string)[]) =>
  Uint8Array.from(xs.flatMap((x) => (typeof x === "string" ? [...x].map((c) => c.charCodeAt(0)) : [x])));

describe("sniffImageExtension", () => {
  const pad = (b: Uint8Array) => Uint8Array.from([...b, 0, 0, 0, 0]);
  it.each([
    ["png", bytes(0x89, "PNG", 0x0d, 0x0a, 0x1a, 0x0a)],
    ["jpg", bytes(0xff, 0xd8, 0xff, 0xe0)],
    ["gif", bytes("GIF89a")],
    ["gif", bytes("GIF87a")],
    ["webp", bytes("RIFF", 1, 2, 3, 4, "WEBPVP8 ")],
    ["avif", bytes(0, 0, 0, 0x1c, "ftypavif", 0, 0, 0, 0)],
    ["avif", bytes(0, 0, 0, 0x1c, "ftypavis", 0, 0, 0, 0)],
    ["avif", bytes(0, 0, 0, 0x1c, "ftypmif1", 0, 0, 0, 0, "miafavif")],
    ["heic", bytes(0, 0, 0, 0x18, "ftypheic", 0, 0, 0, 0)],
    ["heic", bytes(0, 0, 0, 0x1c, "ftypmif1", 0, 0, 0, 0, "mif1heic")],
    ["bmp", bytes("BM", 0x36, 0, 0, 0, 0, 0, 0, 0, 0x36, 0, 0, 0)],
    ["ico", bytes(0, 0, 1, 0, 1, 0, 16, 16)],
    ["svg", bytes('<svg xmlns="http://www.w3.org/2000/svg"></svg>')],
    ["svg", bytes('  \n<?xml version="1.0"?>\n<!-- c --><svg viewBox="0 0 1 1"></svg>')],
    ["svg", bytes(0xef, 0xbb, 0xbf, "<svg></svg>")],
  ])("recognises %s", (ext, data) => {
    expect(sniffImageExtension(pad(data))).toBe(ext);
  });
  it.each([
    ["empty", new Uint8Array()],
    ["too short", bytes(0x89, "PN")],
    ["html", bytes("<!doctype html><html><body>blocked</body></html>")],
    ["xml that is not svg", bytes('<?xml version="1.0"?><rss></rss>')],
    ["json", bytes('{"error":"nope"}')],
    ["a RIFF that is not webp", bytes("RIFF", 1, 2, 3, 4, "WAVEfmt ")],
    ["an mp4", bytes(0, 0, 0, 0x18, "ftypisom", 0, 0, 0, 0)],
    ["a zero-led blob that is not ico", bytes(0, 0, 0, 0, 0, 0, 0, 0)],
  ])("returns undefined for %s", (_n, data) => {
    expect(sniffImageExtension(data)).toBeUndefined();
  });
});

describe("extensionFromContentType", () => {
  it.each([
    ["image/png", "png"],
    ["image/jpeg", "jpg"],
    ["image/JPEG; charset=binary", "jpg"],
    ["image/jpg", "jpg"],
    ["image/gif", "gif"],
    ["image/webp", "webp"],
    ["image/avif", "avif"],
    ["image/heic", "heic"],
    ["image/svg+xml", "svg"],
    ["image/bmp", "bmp"],
    ["image/x-icon", "ico"],
    ["image/vnd.microsoft.icon", "ico"],
  ])("maps %s to %s", (type, ext) => {
    expect(extensionFromContentType(type)).toBe(ext);
  });
  it("returns undefined for anything else", () => {
    expect(extensionFromContentType("text/html")).toBeUndefined();
    expect(extensionFromContentType("application/octet-stream")).toBeUndefined();
    expect(extensionFromContentType(null)).toBeUndefined();
    expect(extensionFromContentType("")).toBeUndefined();
  });
});

describe("resolveAsset and resolveAssets", () => {
  it("makes a relative path absolute", () => {
    expect(resolveAsset("images/a.jpg", "https://site.example/content/")).toBe("https://site.example/content/images/a.jpg");
    expect(resolveAsset("images/a.jpg", "https://site.example/content")).toBe("https://site.example/content/images/a.jpg");
    expect(resolveAsset("images/a.jpg", "/content/")).toBe("/content/images/a.jpg");
  });
  it("leaves absolute and protocol-relative addresses alone", () => {
    expect(resolveAsset("https://images.example/a.jpg", "/content/")).toBe("https://images.example/a.jpg");
    expect(resolveAsset("//images.example/a.jpg", "/content/")).toBe("//images.example/a.jpg");
  });
  it("rewrites relative img sources and nothing else", () => {
    const html = '<p><a href="images/x.jpg">l</a></p><img src="images/a.jpg" alt="images/a.jpg"><img alt="b" src="https://cdn.example/b.jpg">';
    expect(resolveAssets(html, "https://site.example/content/")).toBe(
      '<p><a href="images/x.jpg">l</a></p><img src="https://site.example/content/images/a.jpg" alt="images/a.jpg"><img alt="b" src="https://cdn.example/b.jpg">',
    );
  });
  it("is idempotent", () => {
    const once = resolveAssets('<img src="images/a.jpg">', "https://site.example/content/");
    expect(resolveAssets(once, "https://site.example/content/")).toBe(once);
  });
});
