import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_APP_NAME, ICON_THEME_COLOUR, manifestFor, shortNameOf } from "./manifest.js";

describe("shortNameOf", () => {
  it("keeps a short name as is", () => {
    expect(shortNameOf("Example")).toBe("Example");
    expect(shortNameOf("Exactly 12 c")).toBe("Exactly 12 c");
  });
  it("uses the first word of a long name when it fits, else cuts it", () => {
    expect(shortNameOf("Example Newsletter Weekly")).toBe("Example");
    expect(shortNameOf("Extraordinarilylongword and more")).toBe("Extraordinar");
  });
});

describe("manifestFor", () => {
  it("takes name and short_name from the feed name", () => {
    const m = manifestFor({ feedName: "Example Newsletter Weekly" });
    expect(m.name).toBe("Example Newsletter Weekly");
    expect(m.short_name).toBe("Example");
  });
  it("falls back to a neutral default without a config", () => {
    const m = manifestFor(undefined);
    expect(m.name).toBe(DEFAULT_APP_NAME);
    expect(DEFAULT_APP_NAME).toBe("Reader");
  });
  it("lists any, maskable and vector icons with sizes, types and purposes", () => {
    const { icons } = manifestFor(undefined);
    expect(icons).toEqual(
      expect.arrayContaining([
        { src: "icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
        { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
        { src: "icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        { src: "icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      ]),
    );
  });
  it("is installable relative to wherever it is served", () => {
    const m = manifestFor(undefined);
    expect(m).toMatchObject({ start_url: ".", scope: ".", display: "standalone", theme_color: ICON_THEME_COLOUR });
  });
});

describe("the committed icons", () => {
  const png = (name: string) => readFileSync(new URL(`../public/${name}`, import.meta.url));
  it.each([
    ["icon-192.png", 192],
    ["icon-512.png", 512],
    ["icon-maskable-512.png", 512],
    ["apple-touch-icon.png", 180],
  ])("%s is a %i px square PNG", (name, size) => {
    const b = png(name);
    expect(b.subarray(1, 4).toString("ascii")).toBe("PNG");
    expect(b.readUInt32BE(16)).toBe(size);
    expect(b.readUInt32BE(20)).toBe(size);
  });
  it("every manifest icon exists in public", () => {
    for (const icon of manifestFor(undefined).icons) expect(() => png(icon.src)).not.toThrow();
  });
});
