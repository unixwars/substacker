import { describe, expect, it } from "vitest";
import { DEFAULT_CAP_BYTES, cachePrefix, capFromSearch, classify, contentCacheName, isShellNavigation, scopePath, shellCacheName } from "./offline-shared.js";

describe("naming", () => {
  it("derives a prefix from the base path, so two shells never share names", () => {
    expect(scopePath("https://owner.github.io/repo/")).toBe("/repo/");
    expect(cachePrefix("/a/")).toBe("substacker:/a:".replace("/a:", "/a/:"));
    expect(contentCacheName(cachePrefix("/a/"))).not.toBe(contentCacheName(cachePrefix("/b/")));
  });
  it("a prefix is never a prefix of another shell's names", () => {
    const outer = cachePrefix("/site/");
    const inner = shellCacheName(cachePrefix("/site/nested/"), "x");
    expect(inner.startsWith(outer)).toBe(false);
  });
});

describe("classify", () => {
  const scope = "/repo/";
  it.each([
    ["/repo/content/index.json", "revalidate"],
    ["/repo/content/search.json", "revalidate"],
    ["/repo/config.json", "revalidate"],
    ["/repo/content/posts/hello.json", "post"],
    ["/repo/content/posts/caf%C3%A9.json", "post"],
    ["/repo/content/images/abc.jpeg", "image"],
  ])("%s is %s", (path, kind) => {
    expect(classify(path, scope)).toBe(kind);
  });
  it.each(["/repo/", "/repo/index.html", "/repo/assets/index-abc.js", "/other/content/index.json", "/repo/content/posts/a/b.json"])(
    "%s is not handled",
    (path) => {
      expect(classify(path, scope)).toBeNull();
    },
  );
});

describe("capFromSearch", () => {
  it("reads the cap", () => {
    expect(capFromSearch("?cap=1000")).toBe(1000);
    expect(capFromSearch("?cap=0")).toBe(0);
  });
  it("falls back to the default", () => {
    expect(capFromSearch("")).toBe(DEFAULT_CAP_BYTES);
    expect(capFromSearch("?cap=abc")).toBe(DEFAULT_CAP_BYTES);
    expect(capFromSearch("?cap=-5")).toBe(DEFAULT_CAP_BYTES);
  });
});

describe("isShellNavigation", () => {
  it.each([["/repo/", "/repo/"], ["/repo/index.html", "/repo/"], ["/", "/"], ["/index.html", "/"]])("serves the shell for %s in scope %s", (path, scope) => {
    expect(isShellNavigation(path, scope)).toBe(true);
  });
  it.each([["/other/", "/"], ["/repo/other", "/repo/"], ["/repo/p/x", "/repo/"], ["/repo", "/repo/"], ["/elsewhere/index.html", "/"], ["/repo/content/index.json", "/repo/"]])(
    "leaves %s alone in scope %s",
    (path, scope) => {
      expect(isShellNavigation(path, scope)).toBe(false);
    },
  );
});
