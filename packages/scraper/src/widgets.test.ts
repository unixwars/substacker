import { sanitizeHtml } from "substacker-core/dom";
import type { DomParser } from "substacker-core/dom";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { ctaKind, stripWidgets } from "./widgets.js";

const feed = readFileSync(new URL("../test/fixtures/feed.xml", import.meta.url), "utf8");
const bodies = [...feed.matchAll(/<content:encoded><!\[CDATA\[([\s\S]*?)\]\]><\/content:encoded>/g)].map((m) => m[1] ?? "");
const structural = bodies[0] ?? "";
const parse = (html: string) => new JSDOM(`<body>${html}</body>`).window.document;

describe("ctaKind", () => {
  it.each([
    ["https://example.substack.com/subscribe?", "subscribe"],
    ["https://example.substack.com/subscribe", "subscribe"],
    ["https://example.substack.com/p/x/comments", "comments"],
    ["https://example.substack.com/p/x?utm_source=substack&action=share", "share"],
    ["https://example.com/my-book", null],
    ["not a url at all", null],
  ])("%s is %s", (href, kind) => {
    expect(ctaKind(href)).toBe(kind);
  });
});

describe("stripWidgets on the structural fixture", () => {
  const out = stripWidgets(structural);
  const doc = parse(out);

  it("starts from a fixture that has the real widget markup", () => {
    expect(structural).toContain("button-wrapper");
    expect(structural).toContain("<picture>");
    expect(structural).toContain("<svg");
    expect(structural).toContain("<button");
    expect(structural).toContain("data-attrs");
  });

  it("removes the subscribe, comments and share CTAs", () => {
    expect(out).not.toContain("Subscribe now");
    expect(out).not.toContain("Leave a comment");
    expect(out).not.toMatch(/action=share/);
    expect(out).not.toMatch(/\/subscribe/);
    expect(out).not.toMatch(/\/comments/);
  });

  it("keeps a different button link as a plain link", () => {
    const a = doc.querySelector('a[href="https://example.com/my-book"]');
    expect(a?.textContent).toBe("Buy the book");
    expect(doc.querySelector("p.button-wrapper")).toBeNull();
    expect(a?.closest("p")).not.toBeNull();
  });

  it("drops buttons, svg, data attributes and classes", () => {
    expect(doc.querySelectorAll("button, svg").length).toBe(0);
    expect(out).not.toMatch(/data-/);
    expect(out).not.toMatch(/\sclass=/);
    expect(out).not.toMatch(/srcset|sizes=/);
  });

  it("turns each picture into one image and keeps its text content", () => {
    expect(doc.querySelectorAll("picture, source").length).toBe(0);
    const imgs = [...doc.querySelectorAll("img")].map((i) => i.getAttribute("src"));
    expect(imgs).toHaveLength(2);
    expect(imgs[0]).toContain("substackcdn.com/image/fetch/");
    expect(imgs[0]).toContain("substack-post-media.s3.amazonaws.com");
    expect(imgs[1]).toBe("https://images.unsplash.com/photo-0000000000?w=800&q=80");
  });

  it("keeps the captioned figure with its caption", () => {
    const fig = doc.querySelector("figure");
    expect(fig?.querySelector("img")).not.toBeNull();
    expect(fig?.querySelector("figcaption")?.textContent).toBe("A placeholder caption.");
  });

  it("unwraps the image link to the enlarged copy", () => {
    expect(doc.querySelector("figure a")).toBeNull();
  });

  it("turns the embed into a link to its source", () => {
    expect(doc.querySelector("iframe")).toBeNull();
    const a = doc.querySelector('a[href^="https://www.youtube-nocookie.com/embed/"]');
    expect(a).not.toBeNull();
  });

  it("keeps ordinary text and links", () => {
    expect(out).toContain("<h2>A heading</h2>");
    expect(out).toContain("<strong>bold</strong>");
    expect(out).toContain('href="https://example.com/some-page?utm_source=newsletter"');
    expect(out).toContain("<blockquote>");
  });

  it("leaves no empty wrappers", () => {
    expect([...doc.querySelectorAll("div, span")].filter((e) => !e.textContent?.trim() && !e.querySelector("img"))).toEqual([]);
  });

  it("is deterministic and idempotent", () => {
    expect(stripWidgets(structural)).toBe(out);
    expect(stripWidgets(out)).toBe(out);
  });
});

describe("stripWidgets edge cases", () => {
  it("uses the last source when a picture has no img", () => {
    const out = stripWidgets(`<picture><source srcset="https://x.example/a.jpg 400w, https://x.example/b.jpg 800w"><source srcset="https://x.example/c.jpg 1200w"></picture>`);
    expect(out).toBe('<img src="https://x.example/c.jpg">');
  });
  it("removes a picture with nothing to show", () => {
    expect(stripWidgets("<p>a</p><picture></picture>")).toBe("<p>a</p>");
  });
  it("removes an iframe without a usable source", () => {
    expect(stripWidgets('<iframe src="javascript:alert(1)"></iframe><p>x</p>')).toBe("<p>x</p>");
    expect(stripWidgets("<iframe></iframe><p>x</p>")).toBe("<p>x</p>");
  });
  it("handles an empty body", () => {
    expect(stripWidgets("")).toBe("");
  });
});

describe("stripWidgets followed by sanitizeHtml", () => {
  const win = (() => new JSDOM("").window) as unknown as DomParser;
  const hostile = [
    `<script>alert(1)</script><p onclick="x()">a</p>`,
    `<a href="javascript:alert(1)">x</a><img src=x onerror=alert(1)>`,
    `<iframe src="javascript:alert(1)"></iframe><iframe srcdoc="<script>1</script>"></iframe>`,
    `<p class="button-wrapper"><a class="button primary" href="javascript:alert(1)">x</a></p>`,
    `<picture><source srcset="javascript:alert(1) 1x"><img src="x" onerror="alert(1)"></picture>`,
    `<svg><script>alert(1)</script></svg><button onclick="x()">b</button>`,
  ];
  it.each(hostile)("leaves nothing executable: %s", (input) => {
    const out = sanitizeHtml(stripWidgets(input), win);
    expect(out).not.toMatch(/<script|<iframe|<svg|<button/i);
    expect(out).not.toMatch(/\son\w+\s*=/i);
    expect(out).not.toMatch(/javascript:/i);
  });
});
