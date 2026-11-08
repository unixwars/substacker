import { describe, expect, it } from "vitest";
import type { Entry } from "./contract.js";
import { canonicalUrl, dockLinks, imageName, neighbours, outboundUrl, resolveAsset, resolveAssets } from "./post.js";

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

describe("imageName", () => {
  const cdn =
    "https://substackcdn.com/image/fetch/$s_!abcd!,w_1456,c_limit,f_auto/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F1111_1200x800.jpeg";
  it("is stable for the same address", () => {
    expect(imageName(cdn)).toBe(imageName(cdn));
  });
  it("keeps the extension of the underlying image, lower-cased", () => {
    expect(imageName(cdn)).toMatch(/^[0-9a-f]{14}\.jpeg$/);
    expect(imageName("https://example.com/a/B.PNG")).toMatch(/\.png$/);
    expect(imageName("https://example.com/photo?w=800")).toMatch(/\.bin$/);
  });
  it("differs for different addresses, including the query", () => {
    expect(imageName("https://example.com/a.jpg?w=1")).not.toBe(imageName("https://example.com/a.jpg?w=2"));
    expect(imageName("https://example.com/a.jpg")).not.toBe(imageName("https://example.com/b.jpg"));
  });
  it("has a pinned value, so the scraper and every build agree across versions", () => {
    expect(imageName("https://example.com/a.jpg")).toBe("026d71faef9eb9.jpg");
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
