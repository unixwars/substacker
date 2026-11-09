import { describe, expect, it } from "vitest";
import { listHref, parseHash, postHref } from "./route.js";

describe("hash routes", () => {
  it("parses the list, a search and a post", () => {
    expect(parseHash("")).toEqual({ name: "list", q: "" });
    expect(parseHash("#/")).toEqual({ name: "list", q: "" });
    expect(parseHash("#/?q=tomato%20soup")).toEqual({ name: "list", q: "tomato soup" });
    expect(parseHash("#/p/hello-world")).toEqual({ name: "post", slug: "hello-world" });
  });
  it("round-trips a non-ASCII slug", () => {
    expect(parseHash(postHref("café"))).toEqual({ name: "post", slug: "café" });
  });
  it("falls back to the list on a bad escape", () => {
    expect(parseHash("#/p/%E0%A4%A")).toEqual({ name: "list", q: "" });
  });
  it("builds list links", () => {
    expect(listHref()).toBe("#/");
    expect(listHref("a b")).toBe("#/?q=a%20b");
  });
});
