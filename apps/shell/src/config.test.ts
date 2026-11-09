import { describe, expect, it } from "vitest";
import { ShellConfigSchema } from "./config.js";

const base = { contentUrl: "content/", feedName: "Example Newsletter" };

describe("ShellConfigSchema noindex", () => {
  it("is on by default", () => {
    expect(ShellConfigSchema.parse(base).noindex).toBe(true);
  });
  it("can be turned off", () => {
    expect(ShellConfigSchema.parse({ ...base, noindex: false }).noindex).toBe(false);
  });
});
