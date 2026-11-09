import { describe, expect, it } from "vitest";
import { VERSION } from "substacker-core";
import { generatorMeta } from "./generator.js";

describe("generatorMeta", () => {
  it("names substacker and the version in a generator meta tag", () => {
    expect(generatorMeta("1.2.3")).toEqual({ tag: "meta", attrs: { name: "generator", content: "substacker 1.2.3" }, injectTo: "head" });
  });

  it("uses the core version by default", () => {
    expect(generatorMeta().attrs["content"]).toBe(`substacker ${VERSION}`);
  });
});
