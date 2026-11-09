import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runBuild, runScrape } from "./cli.js";
import { VERSION } from "./version.js";

const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")) as { version: string };

afterEach(() => vi.restoreAllMocks());

describe("--version", () => {
  it("is the scraper package version", () => {
    expect(VERSION).toBe(pkg.version);
  });

  it("makes substacker-scrape print its name and version, and exit 0, before reading any configuration", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    // An empty environment has no configuration: reaching loadConfig would throw.
    await expect(runScrape(["--version"], {})).resolves.toBe(0);
    expect(log).toHaveBeenCalledExactlyOnceWith(`substacker-scrape ${pkg.version}`);
  });

  it("makes substacker-build print its name and version, and exit 0", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(runBuild(["--version"], {})).toBe(0);
    expect(log).toHaveBeenCalledExactlyOnceWith(`substacker-build ${pkg.version}`);
  });

  it("wins over other options", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await expect(runScrape(["--backup", "x", "--version"], {})).resolves.toBe(0);
    expect(log).toHaveBeenCalledExactlyOnceWith(`substacker-scrape ${pkg.version}`);
  });
});
