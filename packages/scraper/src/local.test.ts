import { describe, expect, it } from "vitest";
import {
  backupMessage,
  dispatchRequest,
  dispatchToken,
  lockIsStale,
  parseLock,
  parseRepoSlug,
  summarizeStaged,
} from "./local.js";

describe("parseRepoSlug", () => {
  it.each([
    ["https://github.com/example-owner/example-repo.git", "example-owner/example-repo"],
    ["https://github.com/example-owner/example-repo", "example-owner/example-repo"],
    ["https://github.com/example-owner/example-repo/", "example-owner/example-repo"],
    ["https://x-access-token:secret@github.com/example-owner/example-repo.git", "example-owner/example-repo"],
    ["git@github.com:example-owner/example-repo.git", "example-owner/example-repo"],
    ["ssh://git@github.com/example-owner/example-repo.git", "example-owner/example-repo"],
    ["ssh://git@github.com:22/example-owner/example-repo", "example-owner/example-repo"],
    ["  https://github.com/a.b/c_d-e.git\n", "a.b/c_d-e"],
  ])("reads %s", (url, slug) => {
    expect(parseRepoSlug(url)).toBe(slug);
  });
  it.each([
    "/tmp/some/bare.git",
    "https://gitlab.com/example-owner/example-repo.git",
    "git@gitlab.com:example-owner/example-repo.git",
    "https://github.com/only-owner",
    "https://github.com/a/b/c",
    "https://github.com/../x",
    "",
  ])("returns nothing for %s", (url) => {
    expect(parseRepoSlug(url)).toBeUndefined();
  });
  it("accepts an owner/repo override as written", () => {
    expect(parseRepoSlug("example-owner/example-repo", { bare: true })).toBe("example-owner/example-repo");
    expect(parseRepoSlug("example-owner/example-repo/extra", { bare: true })).toBeUndefined();
    expect(parseRepoSlug("a b/c", { bare: true })).toBeUndefined();
  });
});

describe("summarizeStaged", () => {
  it("counts raw items and images and ignores other paths", () => {
    expect(summarizeStaged(["raw/a.xml", "raw/b.xml", "images/x.png", "other.txt"])).toEqual({ items: 2, images: 1 });
    expect(summarizeStaged([])).toEqual({ items: 0, images: 0 });
  });
});

describe("backupMessage", () => {
  it("states the counts without naming a bot", () => {
    expect(backupMessage({ items: 3, images: 2 })).toBe("backup: 3 new or changed items, 2 images");
    expect(backupMessage({ items: 1, images: 1 })).toBe("backup: 1 new or changed item, 1 image");
    expect(backupMessage({ items: 0, images: 4 })).toBe("backup: 0 new or changed items, 4 images");
  });
});

describe("dispatchToken", () => {
  it("prefers the dedicated variable, then GITHUB_TOKEN, then GH_TOKEN", () => {
    expect(dispatchToken({ SUBSTACKER_DISPATCH_TOKEN: "a", GITHUB_TOKEN: "b", GH_TOKEN: "c" })).toBe("a");
    expect(dispatchToken({ GITHUB_TOKEN: "b", GH_TOKEN: "c" })).toBe("b");
    expect(dispatchToken({ GH_TOKEN: "c" })).toBe("c");
    expect(dispatchToken({ SUBSTACKER_DISPATCH_TOKEN: "  ", GH_TOKEN: "c" })).toBe("c");
    expect(dispatchToken({})).toBeUndefined();
  });
});

describe("dispatchRequest", () => {
  it("builds the workflow_dispatch call", () => {
    const r = dispatchRequest({ slug: "example-owner/example-repo", token: "tok", apiBase: "https://api.github.com" });
    expect(r.url).toBe("https://api.github.com/repos/example-owner/example-repo/actions/workflows/publish.yml/dispatches");
    expect(r.init.method).toBe("POST");
    expect(JSON.parse(String(r.init.body))).toEqual({ ref: "main" });
    const h = r.init.headers as Record<string, string>;
    expect(h["Authorization"]).toBe("Bearer tok");
    expect(h["Accept"]).toBe("application/vnd.github+json");
    expect(h["X-GitHub-Api-Version"]).toBe("2022-11-28");
  });
  it("tolerates a trailing slash on the base", () => {
    expect(dispatchRequest({ slug: "o/r", token: "t", apiBase: "http://127.0.0.1:1/" }).url).toBe(
      "http://127.0.0.1:1/repos/o/r/actions/workflows/publish.yml/dispatches",
    );
  });
  it("refuses a plain-http base unless it is loopback", () => {
    expect(() => dispatchRequest({ slug: "o/r", token: "t", apiBase: "http://example.com" })).toThrow(/https/);
    expect(() => dispatchRequest({ slug: "o/r", token: "t", apiBase: "not a url" })).toThrow();
  });
});

describe("lock", () => {
  it("parses the lock file and rejects junk", () => {
    expect(parseLock('{"pid":12,"startedAt":1000}')).toEqual({ pid: 12, startedAt: 1000 });
    expect(parseLock("nope")).toBeUndefined();
    expect(parseLock('{"pid":"x"}')).toBeUndefined();
    expect(parseLock('{"pid":-1,"startedAt":1}')).toBeUndefined();
  });
  const HOUR = 3_600_000;
  it("is stale when the process is gone", () => {
    expect(lockIsStale({ pid: 5, startedAt: 1000 }, { now: 2000, alive: () => false })).toBe(true);
  });
  it("is live while the process runs and the lock is young", () => {
    expect(lockIsStale({ pid: 5, startedAt: 1000 }, { now: 2000, alive: () => true })).toBe(false);
  });
  it("is stale when too old, even if the pid is reused", () => {
    expect(lockIsStale({ pid: 5, startedAt: 0 }, { now: 7 * HOUR, alive: () => true })).toBe(true);
  });
  it("treats an unreadable lock as stale", () => {
    expect(lockIsStale(undefined, { now: 1, alive: () => true })).toBe(true);
  });
});

describe("scrapeMode", () => {
  it("is local by default and for blank, and ci only when asked", async () => {
    const { scrapeMode } = await import("./local.js");
    expect(scrapeMode(undefined)).toBe("local");
    expect(scrapeMode("")).toBe("local");
    expect(scrapeMode("  ")).toBe("local");
    expect(scrapeMode("local")).toBe("local");
    expect(scrapeMode("ci")).toBe("ci");
    expect(scrapeMode(" CI ")).toBe("ci");
  });
  it("rejects anything else rather than guessing", async () => {
    const { scrapeMode } = await import("./local.js");
    expect(() => scrapeMode("cloud")).toThrow(/SUBSTACKER_SCRAPE.*local.*ci/);
  });
});
