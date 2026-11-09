import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CONTRACT_VERSION, VERSION } from "./index.js";

// One version for the whole repository: the root package.json. Every workspace package
// carries the same number, and the three generated constants (`version.ts` in core,
// scraper and relay) are written from it by `node scripts/sync-version.mjs`.
const root = join(import.meta.dirname, "..", "..", "..");
const json = (path: string) => JSON.parse(readFileSync(join(root, path), "utf8")) as { version: string; workspaces?: string[] };
const rootVersion = json("package.json").version;
const constantIn = (path: string) => /export const VERSION = "([^"]+)";/.exec(readFileSync(join(root, path), "utf8"))?.[1];

describe("version", () => {
  it("is a plain semantic version", () => {
    expect(rootVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it.each(["packages/core", "packages/scraper", "apps/shell", "apps/relay"])("%s has the root version", (dir) => {
    expect(json(`${dir}/package.json`).version).toBe(rootVersion);
  });

  it.each(["packages/scraper", "apps/shell"])("%s depends on exactly ^<version> of substacker-core (run node scripts/sync-version.mjs)", (dir) => {
    const pkg = JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8")) as { dependencies: Record<string, string> };
    expect(pkg.dependencies["substacker-core"]).toBe(`^${rootVersion}`);
  });

  it("is exported by core and is not the content contract version", () => {
    expect(VERSION).toBe(json("packages/core/package.json").version);
    expect(typeof CONTRACT_VERSION).toBe("number");
    expect(String(VERSION)).not.toBe(String(CONTRACT_VERSION));
  });

  it.each(["packages/core/src/version.ts", "packages/scraper/src/version.ts", "apps/relay/src/version.ts"])(
    "%s equals its package version (run node scripts/sync-version.mjs)",
    (file) => {
      expect(constantIn(file)).toBe(rootVersion);
    },
  );

  it("is the version the relay reports in its User-Agent", async () => {
    const relay = await import("../../../apps/relay/src/relay.js");
    expect(relay.VERSION).toBe(json("apps/relay/package.json").version);
    expect(relay.USER_AGENT).toBe(`substacker-relay/${rootVersion}`);
  });
});
