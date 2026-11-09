import { imageFilesByKey, imageKey } from "substacker-core";
import { describe, expect, it } from "vitest";
import { buildIndex, derivePost, imageUrls } from "./derive.js";
import { parseFeed } from "./feed.js";
import { feedXml, fixtureFeed } from "./test-support/feeds.js";

const items = parseFeed(fixtureFeed);
const raw = (slug: string) => items.find((i) => i.slug === slug)?.raw ?? "";
const none = new Map<string, string>();

describe("imageUrls", () => {
  it("lists the cover and the images kept in the body, once each, http(s) only", () => {
    const urls = imageUrls(raw("hello-world"));
    expect(urls).toHaveLength(2);
    expect(urls.some((u) => u.includes("substackcdn.com/image/fetch/") && u.includes("amazonaws.com"))).toBe(true);
    expect(urls).toContain("https://images.unsplash.com/photo-0000000000?w=800&q=80");
  });
  it("is empty for a text-only item", () => {
    expect(imageUrls(raw("just-text"))).toEqual([]);
  });
});

describe("derivePost", () => {
  it("builds a valid post from the structural item", () => {
    const post = derivePost(raw("hello-world"), none);
    expect(post).toMatchObject({
      version: 1,
      slug: "hello-world",
      title: "Hello, world",
      date: "2026-03-02T10:00:00.000Z",
      excerpt: "A placeholder subtitle.",
      sourceUrl: "https://example.substack.com/p/hello-world",
    });
    expect(post.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });
  it("strips widgets and sanitizes", () => {
    const { html } = derivePost(raw("hello-world"), none);
    expect(html).not.toMatch(/button-wrapper|<svg|<button|<picture|<iframe|data-attrs|class=/);
    expect(html).toContain("A placeholder caption.");
    expect(html).toContain('rel="noopener noreferrer"');
  });
  it("keeps remote addresses and counts them when no local copy exists", () => {
    const post = derivePost(raw("hello-world"), none);
    expect(post.unlocalized).toBe(2);
    expect(post.html).toContain("https://images.unsplash.com/photo-0000000000?w=800&amp;q=80");
    expect(post.cover).toContain("substackcdn.com");
  });
  it("points at local copies that are present", () => {
    const present = imageFilesByKey(imageUrls(raw("hello-world")).map((u, i) => `${imageKey(u)}.${i === 0 ? "webp" : "png"}`));
    const post = derivePost(raw("hello-world"), present);
    expect(post.unlocalized).toBe(0);
    expect(post.html).not.toContain("substackcdn.com");
    expect(post.html).not.toContain("unsplash");
    expect(post.html).toMatch(/src="images\/[0-9a-f]{14}\.(webp|png)"/);
    expect(post.cover).toMatch(/^images\/[0-9a-f]{14}\.(webp|png)$/);
  });
  it("marks only the image whose file is missing", () => {
    const urls = imageUrls(raw("hello-world"));
    const present = imageFilesByKey([`${imageKey(urls[0] ?? "")}.jpg`]);
    const post = derivePost(raw("hello-world"), present);
    expect(post.unlocalized).toBe(1);
  });
  it("falls back to the first body image as cover without an enclosure", () => {
    const xml = feedXml([{ title: "T", link: "https://example.substack.com/p/t", body: '<p>x</p><img src="https://img.example/a.png">' }]);
    const [item] = parseFeed(xml);
    expect(derivePost(item?.raw ?? "", none).cover).toBe("https://img.example/a.png");
  });
  it("has no cover for a text-only post and derives the excerpt from the body", () => {
    const post = derivePost(raw("just-text"), none);
    expect(post.cover).toBeNull();
    expect(post.excerpt).toBe("A text-only placeholder post with no images.");
    expect(post.unlocalized).toBe(0);
  });
  it("truncates a long excerpt at a word boundary", () => {
    const xml = feedXml([{ title: "T", link: "https://example.substack.com/p/long", body: `<p>${"word ".repeat(100)}</p>` }]);
    const post = derivePost(parseFeed(xml)[0]?.raw ?? "", none);
    expect(post.excerpt.length).toBeLessThanOrEqual(201);
    expect(post.excerpt.endsWith("word…")).toBe(true);
  });
  it("keeps the slug and changes title and hash when the title is edited", () => {
    const a = derivePost(parseFeed(feedXml([{ title: "Old", link: "https://example.substack.com/p/same" }]))[0]?.raw ?? "", none);
    const b = derivePost(parseFeed(feedXml([{ title: "New", link: "https://example.substack.com/p/same" }]))[0]?.raw ?? "", none);
    expect(a.slug).toBe(b.slug);
    expect(a.title).not.toBe(b.title);
    expect(a.contentHash).not.toBe(b.contentHash);
  });
  it("handles a non-ASCII slug", () => {
    const xml = feedXml([{ title: "Café", link: "https://example.substack.com/p/caf%C3%A9" }]);
    expect(derivePost(parseFeed(xml)[0]?.raw ?? "", none).slug).toBe("café");
  });
  it("follows a changed sanitizer policy", () => {
    const base = derivePost(raw("hello-world"), none);
    const strict = derivePost(raw("hello-world"), none, {
      policy: { allowedTags: ["p", "a"], allowedAttributes: ["href"], allowedSchemes: ["https"] },
    });
    expect(base.html).toContain("<img");
    expect(strict.html).not.toContain("<img");
    expect(strict.html).not.toBe(base.html);
  });
  it("is deterministic", () => {
    expect(derivePost(raw("hello-world"), none)).toEqual(derivePost(raw("hello-world"), none));
  });
});

describe("buildIndex", () => {
  const posts = items.map((i) => derivePost(i.raw, none));
  it("lists posts newest first with the feed title", () => {
    const { index, docs } = buildIndex(posts, [], "Example Newsletter");
    expect(index.title).toBe("Example Newsletter");
    expect(index.posts.map((p) => p.slug)).toEqual(["just-text", "second-post", "hello-world"]);
    expect(docs.map((d) => d.slug)).toEqual(["just-text", "second-post", "hello-world"]);
    expect(docs[2]?.text).toContain("Welcome to the first placeholder post");
    expect(docs[2]?.text).not.toMatch(/</);
  });
  it("leaves hidden slugs out of both and warns about an unknown one", () => {
    const { index, docs, warnings } = buildIndex(posts, ["second-post", "nope"], "T");
    expect(index.posts.map((p) => p.slug)).not.toContain("second-post");
    expect(docs.map((d) => d.slug)).not.toContain("second-post");
    expect(warnings).toEqual(["hidden slug matches no stored post: nope"]);
  });
  it("does not warn when a hidden slug matches", () => {
    expect(buildIndex(posts, ["second-post"], "T").warnings).toEqual([]);
  });
  it("is valid for no posts", () => {
    const { index, docs } = buildIndex([], [], "T");
    expect(index).toEqual({ version: 1, title: "T", posts: [] });
    expect(docs).toEqual([]);
  });
  it("lists a slug once if given twice", () => {
    const dup = [posts[0], posts[0]].filter((p) => p !== undefined);
    expect(buildIndex(dup, [], "T").index.posts).toHaveLength(1);
  });
});
