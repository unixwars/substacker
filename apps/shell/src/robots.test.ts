import { describe, expect, it } from "vitest";
import { robotsMeta } from "./robots.js";

describe("robotsMeta", () => {
  it("is a noindex robots meta tag in the head when noindex is on", () => {
    expect(robotsMeta(true)).toEqual({ tag: "meta", attrs: { name: "robots", content: "noindex" }, injectTo: "head" });
  });

  it("is nothing when noindex is off, so search engines may index the page", () => {
    expect(robotsMeta(false)).toBeUndefined();
  });
});
