// @vitest-environment node
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import type { DomParser } from "./dom.js";
import { sanitizeHtml } from "./dom.js";
import { SANITIZE_POLICY, allowedUriPattern } from "./sanitize-policy.js";

const parse = (() => new JSDOM("").window) as unknown as DomParser;
const clean = (html: string) => sanitizeHtml(html, parse);

const hostile: string[] = [
  `<p>hi</p><script>alert(1)</script>`,
  `<img src=x onerror="alert(1)">`,
  `<a href="javascript:alert(1)">x</a>`,
  `<a href=" JaVaScRiPt:alert(1)">x</a>`,
  `<a href="java&#x09;script:alert(1)">x</a>`,
  `<a href="data:text/html,<script>alert(1)</script>">x</a>`,
  `<iframe src="https://evil.example/"></iframe>`,
  `<iframe srcdoc="<script>alert(1)</script>"></iframe>`,
  `<svg onload="alert(1)"><script>alert(1)</script><a xlink:href="javascript:alert(1)"><text>x</text></a></svg>`,
  `<math><mi xlink:href="javascript:alert(1)">x</mi></math>`,
  `<object data="x"></object><embed src="x">`,
  `<form action="https://evil.example"><input name=a><button>go</button></form>`,
  `<div style="background:url(javascript:alert(1))" onclick="alert(1)">x</div>`,
  `<style>*{display:none}</style><p>x</p>`,
  `<base href="https://evil.example/"><meta http-equiv="refresh" content="0;url=https://evil.example">`,
  `<noscript><p title="</noscript><img src=x onerror=alert(1)>">`,
  `<p id="a" name="b" data-attrs='{"x":1}' class="c">x</p>`,
  `<img src="javascript:alert(1)">`,
  `<a href="https://example.substack.com/p/x" target="_blank">x</a>`,
];

describe("sanitizeHtml", () => {
  it.each(hostile)("neutralizes %s", (input) => {
    const out = clean(input);
    expect(out).not.toMatch(/<script|<iframe|<svg|<math|<object|<embed|<form|<style|<base|<meta/i);
    expect(out).not.toMatch(/\son\w+\s*=/i);
    expect(out).not.toMatch(/javascript:/i);
    expect(out).not.toMatch(/\sstyle\s*=|\sdata-|\sclass=|\sid=|\sname=/i);
    expect(out).not.toMatch(/data:text/i);
    const doc = new JSDOM(out).window.document;
    expect(doc.querySelectorAll("script,iframe,svg,form,style").length).toBe(0);
  });

  it("keeps ordinary content", () => {
    const html = `<h2>Title</h2><p>Some <em>text</em> with a <a href="https://example.substack.com/p/x">link</a>.</p><figure><img src="images/a.jpg" alt="A"><figcaption>Caption</figcaption></figure><ul><li>one</li></ul>`;
    const out = clean(html);
    expect(out).toContain("<h2>Title</h2>");
    expect(out).toContain("<figcaption>Caption</figcaption>");
    expect(out).toContain('src="images/a.jpg"');
    expect(out).toContain('href="https://example.substack.com/p/x"');
  });

  it("keeps relative and mailto links, drops other schemes", () => {
    expect(clean(`<a href="mailto:a@example.com">m</a>`)).toContain("mailto:a@example.com");
    expect(clean(`<a href="ftp://example.com/x">f</a>`)).not.toContain("ftp:");
    expect(clean(`<img src="images/a.jpg">`)).toContain("images/a.jpg");
  });

  it("marks links noopener noreferrer", () => {
    expect(clean(`<a href="https://example.com/">x</a>`)).toContain('rel="noopener noreferrer"');
  });

  it("is idempotent", () => {
    const once = clean(hostile.join(""));
    expect(clean(once)).toBe(once);
  });

  it("follows a different policy", () => {
    const out = sanitizeHtml("<p>a<b>b</b></p>", parse, { ...SANITIZE_POLICY, allowedTags: ["p"] });
    expect(out).toBe("<p>ab</p>");
  });
});

describe("allowedUriPattern", () => {
  it("accepts allowed schemes and relative paths only", () => {
    const re = allowedUriPattern();
    expect(re.test("https://example.com")).toBe(true);
    expect(re.test("images/a.jpg")).toBe(true);
    expect(re.test("/p/x")).toBe(true);
    expect(re.test("#top")).toBe(true);
    expect(re.test("javascript:alert(1)")).toBe(false);
    expect(re.test("data:text/html,x")).toBe(false);
  });
});
