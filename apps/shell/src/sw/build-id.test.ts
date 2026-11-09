import { describe, expect, it } from "vitest";
import { buildId } from "./build-id.js";

const files = (entries: Record<string, string>) => new Map(Object.entries(entries).map(([k, v]) => [k, new TextEncoder().encode(v)]));

describe("buildId", () => {
  it("changes when a file's contents change, though its name does not", () => {
    const a = buildId(files({ "manifest.webmanifest": '{"name":"A"}', "icon-192.png": "png1" }));
    expect(buildId(files({ "manifest.webmanifest": '{"name":"B"}', "icon-192.png": "png1" }))).not.toBe(a);
    expect(buildId(files({ "manifest.webmanifest": '{"name":"A"}', "icon-192.png": "png2" }))).not.toBe(a);
  });
  it("changes when a file is added or renamed", () => {
    const a = buildId(files({ "a.js": "x" }));
    expect(buildId(files({ "a.js": "x", "b.js": "y" }))).not.toBe(a);
    expect(buildId(files({ "c.js": "x" }))).not.toBe(a);
  });
  it("does not depend on the order of the files, and is stable", () => {
    const one = buildId(files({ "a.js": "x", "b.js": "y" }));
    expect(buildId(files({ "b.js": "y", "a.js": "x" }))).toBe(one);
    expect(one).toMatch(/^[0-9a-f]{12}$/);
  });
  it("does not confuse where one file ends and the next begins", () => {
    expect(buildId(files({ a: "bc", d: "" }))).not.toBe(buildId(files({ a: "b", cd: "" })));
  });
});
