import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { imageKey, parseDocs, parseIndex, parsePost } from "substacker-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { build } from "./build.js";
import type { Config } from "./config.js";
import { imageUrls } from "./derive.js";
import { parseFeed } from "./feed.js";
import { fixtureFeed } from "./test-support/feeds.js";

const config: Config = { feedUrl: "https://example.substack.com/feed", feedName: "Example Newsletter", actions: [], utmSource: "substacker", noindex: true, hidden: [] };
let dir = "";

function seed(withImages: boolean) {
  mkdirSync(join(dir, "raw"), { recursive: true });
  mkdirSync(join(dir, "images"), { recursive: true });
  for (const { slug, raw } of parseFeed(fixtureFeed)) {
    writeFileSync(join(dir, "raw", `${slug}.xml`), raw);
    if (withImages) for (const url of imageUrls(raw)) writeFileSync(join(dir, "images", `${imageKey(url)}.png`), "img");
  }
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "substacker-build-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const text = (v: string | Uint8Array | undefined) => (typeof v === "string" ? v : "");

describe("build with an unusable raw item", () => {
  it("skips it with a warning instead of throwing, and builds the rest", () => {
    seed(true);
    writeFileSync(join(dir, "raw", "nodate.xml"), `<item><title>x</title><link>https://example.substack.com/p/nodate</link></item>`);
    writeFileSync(join(dir, "raw", "garbage.xml"), "not xml <<<");
    const { files, warnings } = build(config, dir);
    expect(parseIndex(JSON.parse(text(files.get("index.json")))).posts).toHaveLength(3);
    expect(files.has("posts/nodate.json")).toBe(false);
    expect(warnings.join("\n")).toMatch(/nodate/);
    expect(warnings.join("\n")).toMatch(/garbage/);
  });
});

describe("build with a stored SVG", () => {
  it("publishes it sanitized, and leaves out one that is not an SVG", () => {
    seed(false);
    writeFileSync(join(dir, "images", "aaaaaaaaaaaaaa.svg"), `<svg xmlns="http://www.w3.org/2000/svg" onload="x()"><script>x()</script><rect/></svg>`);
    writeFileSync(join(dir, "images", "bbbbbbbbbbbbbb.svg"), "<html>nope</html>");
    const { files, warnings } = build(config, dir);
    const svg = new TextDecoder().decode(files.get("images/aaaaaaaaaaaaaa.svg") as Uint8Array);
    expect(svg).toContain("<rect");
    expect(svg).not.toMatch(/script|onload/);
    expect(files.has("images/bbbbbbbbbbbbbb.svg")).toBe(false);
    expect(warnings.join("\n")).toMatch(/bbbbbbbbbbbbbb/);
  });
});

describe("build", () => {
  it("writes valid served files", () => {
    seed(true);
    const { files } = build(config, dir);
    expect(parseIndex(JSON.parse(text(files.get("index.json")))).posts).toHaveLength(3);
    expect(parseDocs(JSON.parse(text(files.get("search.json"))))).toHaveLength(3);
    expect(parsePost(JSON.parse(text(files.get("posts/hello-world.json")))).unlocalized).toBe(0);
    expect([...files.keys()].filter((k) => k.startsWith("images/")).length).toBeGreaterThan(0);
  });
  it("finds an image by its key whatever its extension, from names alone", () => {
    seed(false);
    for (const [i, url] of parseFeed(fixtureFeed).flatMap((x) => imageUrls(x.raw)).entries()) {
      writeFileSync(join(dir, "images", `${imageKey(url)}.${i % 2 ? "webp" : "gif"}`), "img");
    }
    const post = parsePost(JSON.parse(text(build(config, dir).files.get("posts/hello-world.json"))));
    expect(post.unlocalized).toBe(0);
    expect(post.html).toMatch(/src="images\/[0-9a-f]{14}\.(webp|gif)"/);
  });
  it("is identical on two runs", () => {
    seed(true);
    expect([...build(config, dir).files]).toEqual([...build(config, dir).files]);
  });
  it("marks posts unlocalized until the images arrive", () => {
    seed(false);
    const post = parsePost(JSON.parse(text(build(config, dir).files.get("posts/hello-world.json"))));
    expect(post.unlocalized).toBe(2);
    seed(true);
    expect(parsePost(JSON.parse(text(build(config, dir).files.get("posts/hello-world.json")))).unlocalized).toBe(0);
  });
  it("hides and unhides without touching the backup", () => {
    seed(true);
    const hidden = build({ ...config, hidden: ["second-post", "nope"] }, dir);
    expect(parseIndex(JSON.parse(text(hidden.files.get("index.json")))).posts.map((p) => p.slug)).not.toContain("second-post");
    expect(parseDocs(JSON.parse(text(hidden.files.get("search.json")))).map((d) => d.slug)).not.toContain("second-post");
    expect(hidden.warnings).toEqual(["hidden slug matches no stored post: nope"]);
    const shown = build(config, dir);
    expect(parseIndex(JSON.parse(text(shown.files.get("index.json")))).posts.map((p) => p.slug)).toContain("second-post");
    expect(shown.warnings).toEqual([]);
  });
  it("changes the output when the sanitizer policy changes, with no feed fetch", () => {
    seed(true);
    const a = text(build(config, dir).files.get("posts/second-post.json"));
    const b = text(build(config, dir, { policy: { allowedTags: ["p"], allowedAttributes: [], allowedSchemes: ["https"] } }).files.get("posts/second-post.json"));
    expect(a).not.toBe(b);
  });
  it("keeps a post whose item is no longer in any feed", () => {
    seed(true);
    expect(build(config, dir).files.has("posts/just-text.json")).toBe(true);
  });
  it("builds a valid empty site from an empty backup", () => {
    const { files } = build(config, dir);
    expect(parseIndex(JSON.parse(text(files.get("index.json")))).posts).toEqual([]);
  });
});
