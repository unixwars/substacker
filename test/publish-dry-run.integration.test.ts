import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";

// The dry run executes the publish workflow's steps against the fixture feed (served
// locally) and reports what it would commit to `content` and what it would deploy.

const root = join(import.meta.dirname, "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
let work = "";

interface Report {
  commit: string[];
  deploy: string[];
  siteBytes: number;
}

const dryRun = (...extra: string[]): Report =>
  JSON.parse(
    execFileSync("node", [join(root, "scripts", "publish-dry-run.mjs"), "--workdir", work, "--json", ...extra], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }),
  ) as Report;

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "substacker-dry-run-"));
  execFileSync(npm, ["run", "build", "-w", "substacker-core", "-w", "substacker-scraper"], { cwd: root, stdio: "ignore" });
});
afterAll(() => rmSync(work, { recursive: true, force: true }));

it("lists the backup files of a first run, and none on a second", () => {
  const first = dryRun();
  expect(first.commit).toEqual(expect.arrayContaining(["raw/hello-world.xml", "raw/second-post.xml", "raw/just-text.xml"]));
  expect(first.commit.filter((f) => f.startsWith("images/")).length).toBeGreaterThan(0);
  expect(first.commit.every((f) => f.startsWith("raw/") || f.startsWith("images/"))).toBe(true);
  expect(first.commit.some((f) => f.endsWith(".bin"))).toBe(false);

  const second = dryRun();
  expect(second.commit).toEqual([]);
});

it("lists one Pages site: the shell at the root and the served files under content/", () => {
  const { deploy, siteBytes } = dryRun();
  expect(deploy).toEqual(
    expect.arrayContaining([
      "index.html",
      "sw.js",
      "config.json",
      "manifest.webmanifest",
      "icon-512.png",
      "content/index.json",
      "content/search.json",
      "content/posts/hello-world.json",
    ]),
  );
  expect(deploy.some((f) => f.startsWith("content/images/"))).toBe(true);
  // The backup's raw items are never published.
  expect(deploy.some((f) => f.startsWith("raw/") || f.startsWith("content/raw/"))).toBe(false);
  expect(deploy).toEqual([...deploy].sort());
  expect(siteBytes).toBeGreaterThan(0);
});

it("leaves nothing behind when no work directory is given", () => {
  const out = execFileSync("node", [join(root, "scripts", "publish-dry-run.mjs"), "--json"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const report = JSON.parse(out) as Report & { workdir?: string };
  expect(report.commit.length).toBeGreaterThan(0);
  expect(report.workdir === undefined || !existsSync(report.workdir)).toBe(true);
});
