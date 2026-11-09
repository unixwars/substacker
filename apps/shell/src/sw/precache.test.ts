import { describe, expect, it } from "vitest";
import { precacheList } from "./precache.js";

describe("precacheList", () => {
  it("lists the shell files, sorted, with the scope root first", () => {
    expect(precacheList(["index.html", "assets/b-123.js", "assets/a-456.css", "manifest.webmanifest"])).toEqual([
      "./", "assets/a-456.css", "assets/b-123.js", "index.html", "manifest.webmanifest",
    ]);
  });
  it("leaves out the worker itself, source maps, config and content", () => {
    expect(precacheList(["sw.js", "assets/a.js.map", "config.json", "content/index.json", "index.html"])).toEqual(["./", "index.html"]);
  });
  it("normalizes separators and leading dots", () => {
    expect(precacheList(["./assets\\x.js"])).toEqual(["./", "assets/x.js"]);
  });
});
