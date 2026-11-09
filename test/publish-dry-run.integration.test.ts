import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The dry run executes the publish workflow's steps against the fixture feed (served
// locally) and reports what it would commit to `content` and what it would deploy.

const root = join(import.meta.dirname, "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
let work = "";

interface Report {
  mode: string;
  commit: string[];
  deploy: string[];
  siteBytes: number;
}

// `ci` unless a test says otherwise: these are the original expectations of the scrape-in-CI path.
const dryRun = (...extra: string[]): Report =>
  JSON.parse(
    execFileSync("node", [join(root, "scripts", "publish-dry-run.mjs"), "--workdir", work, "--json", ...(extra.includes("--mode") ? [] : ["--mode", "ci"]), ...extra], {
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
  const out = execFileSync("node", [join(root, "scripts", "publish-dry-run.mjs"), "--json", "--mode", "ci"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const report = JSON.parse(out) as Report & { workdir?: string };
  expect(report.commit.length).toBeGreaterThan(0);
  expect(report.workdir === undefined || !existsSync(report.workdir)).toBe(true);
});

it("succeeds for a feed with no images, where images/ never exists", () => {
  const dir = mkdtempSync(join(tmpdir(), "substacker-dry-run-noimg-"));
  try {
    const feed = join(dir, "feed.xml");
    writeFileSync(
      feed,
      `<?xml version="1.0"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>T</title>
<item><title>Plain</title><link>https://example.substack.com/p/plain</link><pubDate>Mon, 02 Mar 2026 10:00:00 GMT</pubDate><content:encoded><![CDATA[<p>No images here.</p>]]></content:encoded></item>
</channel></rss>`,
    );
    const out = execFileSync("node", [join(root, "scripts", "publish-dry-run.mjs"), "--workdir", join(dir, "work"), "--feed", feed, "--mode", "ci", "--json"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const report = JSON.parse(out) as Report;
    expect(report.commit).toEqual(["raw/plain.xml"]);
    expect(report.deploy).toContain("content/posts/plain.json");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("local mode (the default): the workflow does not scrape", () => {
  it("scrapes nothing and commits nothing, yet lists the deploy files", () => {
    const localWork = mkdtempSync(join(tmpdir(), "substacker-dry-run-local-"));
    try {
      const run = () =>
        JSON.parse(
          execFileSync("node", [join(root, "scripts", "publish-dry-run.mjs"), "--workdir", localWork, "--json", "--mode", "local"], {
            cwd: root,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
          }),
        ) as Report;
      const report = run();
      expect(report.mode).toBe("local");
      expect(report.commit).toEqual([]);
      expect(report.deploy).toEqual(expect.arrayContaining(["index.html", "content/index.json", "content/posts/hello-world.json"]));
      expect(report.deploy.some((f) => f.startsWith("content/images/"))).toBe(true);
      expect(run().commit).toEqual([]);
    } finally {
      rmSync(localWork, { recursive: true, force: true });
    }
  });

  it("is the default when SUBSTACKER_SCRAPE is unset", () => {
    const out = execFileSync("node", [join(root, "scripts", "publish-dry-run.mjs"), "--json"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, SUBSTACKER_SCRAPE: undefined },
    });
    expect((JSON.parse(out) as Report).mode).toBe("local");
  });
});

describe("the check step", () => {
  const publish = (backup: string, mode: string) => {
    try {
      const out = execFileSync("node", [join(root, "scripts", "publish.mjs"), "check", "--backup", backup], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, SUBSTACKER_SCRAPE: mode },
      });
      return { code: 0, out, err: "" };
    } catch (e) {
      const x = e as { status: number; stdout: string; stderr: string };
      return { code: x.status, out: x.stdout, err: x.stderr };
    }
  };

  it("in local mode fails on an empty content branch and says how to fix it", () => {
    const empty = mkdtempSync(join(tmpdir(), "substacker-check-"));
    try {
      const r = publish(empty, "local");
      expect(r.code).toBe(1);
      expect(r.err).toContain("npm run scrape:local -- --init");
      expect(publish(empty, "").code).toBe(1);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("passes in local mode once raw items exist, and always in ci mode", () => {
    const dir = mkdtempSync(join(tmpdir(), "substacker-check-"));
    try {
      expect(publish(dir, "ci").code).toBe(0);
      mkdirSync(join(dir, "raw"));
      writeFileSync(join(dir, "raw", "a.xml"), "<item/>");
      const r = publish(dir, "local");
      expect(r.code).toBe(0);
      expect(r.out).toContain("1 backed-up post");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects an unknown mode", () => {
    const dir = mkdtempSync(join(tmpdir(), "substacker-check-"));
    try {
      const r = publish(dir, "cloud");
      expect(r.code).toBe(1);
      expect(r.err).toContain("SUBSTACKER_SCRAPE");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
