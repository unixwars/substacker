import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// `scripts/backfill-export.mjs` over a hand-made export zip, then the real scraper build over
// the backup it wrote. Nothing leaves the machine. The zip also holds personal-data entries
// whose lines are canary addresses: they must never reach the output, the files or the logs.

const root = join(import.meta.dirname, "..");
const script = join(root, "scripts", "backfill-export.mjs");
const buildBin = join(root, "packages", "scraper", "dist", "bin", "build.js");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const enc = (s: string) => new TextEncoder().encode(s);
const CANARY = "canary@example.invalid";
const SECRET = "UNPUBLISHED-BODY-MARKER";
const ORIGIN = "https://example.substack.com";
const ENV = { SUBSTACKER_CONFIG: JSON.stringify({ feedUrl: `${ORIGIN}/feed`, feedName: "Example Newsletter" }) };

const S3 = "https://substack-post-media.s3.amazonaws.com/public/images/11111111-1111-4111-8111-111111111111_1200x800.jpeg";
const cdn = (w: number) => `https://substackcdn.com/image/fetch/$s_!abcd!,w_${w},c_limit,f_auto,q_auto:good/${encodeURIComponent(S3)}`;
const withImage = `<p>First placeholder post.</p><div class="captioned-image-container"><figure><picture><source type="image/webp" srcset="${cdn(424)} 424w, ${cdn(848)} 848w"><img src="${cdn(1456)}"></picture></figure></div><button>Share</button><svg><path d="M0 0"/></svg>`;

const HEADER = "post_id,post_date,is_published,email_sent_at,inbox_sent_at,type,audience,title,subtitle,podcast_url";
const csvRow = (...f: string[]) => [...f, ""].map((v) => (/[",\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v)).join(",");
const rows = [
  csvRow("101", "2026-03-02T10:00:00.000Z", "true", "", "", "newsletter", "everyone", "Hello, world", "A placeholder subtitle."),
  csvRow("102", "2026-03-01T08:30:00.000Z", "true", "", "", "newsletter", "everyone", 'Quoted "title", with\na line break', "Ends ]]> badly"),
  csvRow("103", "2026-03-10T09:00:00.000Z", "true", "", "", "newsletter", "everyone", "Already here", ""),
  csvRow("104", "2026-03-11T09:00:00.000Z", "false", "", "", "newsletter", "everyone", "A draft", ""),
  csvRow("105", "2026-03-12T09:00:00.000Z", "false", "", "", "adhoc_email", "everyone", "An email-only send", ""),
  csvRow("106", "2026-03-13T09:00:00.000Z", "true", "", "", "newsletter", "only_paid", "For paying readers", ""),
  csvRow("107", "2026-03-14T09:00:00.000Z", "false", "", "", "newsletter", "only_paid", "A paid draft", ""),
  csvRow("108", "2026-03-15T09:00:00.000Z", "true", "", "", "newsletter", "everyone", "No html file", ""),
  csvRow("109", "2026-03-16T09:00:00.000Z", "true", "", "", "newsletter", "everyone", "Odd name", ""),
];

function makeZip(over: Record<string, Uint8Array> = {}): Uint8Array {
  return zipSync({
    "posts.csv": enc([HEADER, ...rows].join("\n") + "\n"),
    "posts/101.first-post.html": enc(withImage),
    "posts/102.second-post.html": enc("<p>Second placeholder post, no images. ]]> and </item> inside.</p>"),
    "posts/103.existing-post.html": enc("<p>Export copy of an existing post.</p>"),
    "posts/104.draft-slug-x.html": enc(`<p>${SECRET}</p>`),
    "posts/105.adhoc-slug-x.html": enc(`<p>${SECRET}</p>`),
    "posts/106.paid-post.html": enc("<p>Paid.</p>"),
    "posts/107.paid-draft-x.html": enc(`<p>${SECRET}</p>`),
    "posts/109...html": enc("<p>Odd.</p>"),
    "email_list.example.csv": enc(`email,created_at\n${CANARY},2026-01-01\n`),
    "posts/101.delivers.csv": enc(`email,delivered_at\n${CANARY},2026-03-02\n`),
    "posts/101.opens.csv": enc(`email,opened_at\n${CANARY},2026-03-02\n`),
    ...over,
  });
}

let top = "";
let n = 0;
const fresh = (name: string) => {
  const dir = join(top, `${name}-${n++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};
const run = (args: string[], env: Record<string, string> = ENV) => {
  const r = spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env: { PATH: process.env["PATH"] ?? "", ...env } });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const filesUnder = (dir: string): string[] =>
  existsSync(dir) ? readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name)).sort() : [];

beforeAll(() => {
  execFileSync(npm, ["run", "build", "-w", "substacker-core", "-w", "substacker-scraper"], { cwd: root, stdio: "ignore" });
  top = mkdtempSync(join(tmpdir(), "substacker-backfill-"));
});
afterAll(() => {
  if (top) rmSync(top, { recursive: true, force: true });
});

const EXISTING = `<item><title><![CDATA[Original title]]></title><link>${ORIGIN}/p/existing-post</link><guid isPermaLink="false">post:103</guid><pubDate>Tue, 10 Mar 2026 09:00:00 GMT</pubDate><content:encoded><![CDATA[<p>The feed's own copy.</p>]]></content:encoded></item>`;

describe("backfill-export", () => {
  it("answers --version", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };
    expect(run(["--version"]).out.trim()).toBe(`substacker-backfill-export ${pkg.version}`);
  });

  it("dry run, write, second write, build; personal data never appears", () => {
    const dir = fresh("run");
    const zip = join(dir, "export.zip");
    writeFileSync(zip, makeZip());
    const backup = join(dir, "backup");
    mkdirSync(join(backup, "raw"), { recursive: true });
    writeFileSync(join(backup, "raw", "existing-post.xml"), EXISTING);
    const before = readFileSync(join(backup, "raw", "existing-post.xml"), "utf8");
    const outputs: string[] = [];

    // Dry run: the plan, no files.
    const dry = run(["--export", zip, "--backup", backup, "--origin", ORIGIN]);
    outputs.push(dry.out, dry.err);
    expect(dry.code, dry.err).toBe(0);
    expect(dry.out).toContain("DRY RUN");
    expect(dry.out).toContain("to add: 2");
    expect(dry.out).toMatch(/unpublished: 3/);
    expect(dry.out).toMatch(/not-everyone: 1/);
    expect(dry.out).toMatch(/no-html: 1/);
    expect(dry.out).toMatch(/unsafe-slug: 1/);
    expect(dry.out).toMatch(/already-present: 1/);
    expect(dry.out).toMatch(/substackcdn\.com/);
    expect(dry.out).toMatch(/substack-post-media\.s3\.amazonaws\.com/);
    expect(filesUnder(backup).map((f) => f.slice(backup.length + 1))).toEqual(["raw/existing-post.xml"]);

    // Write: exactly the two new items.
    const hosts = join(dir, "hosts.json");
    const w1 = run(["--export", zip, "--backup", backup, "--origin", ORIGIN, "--write", "--hosts-json", hosts]);
    outputs.push(w1.out, w1.err);
    expect(w1.code).toBe(0);
    expect(filesUnder(backup).map((f) => f.slice(backup.length + 1))).toEqual(["raw/existing-post.xml", "raw/first-post.xml", "raw/second-post.xml"]);
    expect(readFileSync(join(backup, "raw", "existing-post.xml"), "utf8")).toBe(before);
    const hostCounts = JSON.parse(readFileSync(hosts, "utf8")) as Record<string, number>;
    expect(hostCounts["substackcdn.com"]).toBe(3);
    expect(hostCounts["substack-post-media.s3.amazonaws.com"]).toBe(3);
    const first = readFileSync(join(backup, "raw", "first-post.xml"), "utf8");
    expect(first).toContain(`<link>${ORIGIN}/p/first-post</link>`);
    expect(first).toContain("<substacker:source>export</substacker:source>");
    expect(first).toContain(`<enclosure url="${cdn(1456)}"`);
    expect(first).toContain("<pubDate>Mon, 02 Mar 2026 10:00:00 GMT</pubDate>");

    // A second write changes nothing.
    const stamp = filesUnder(backup).map((f) => [f, readFileSync(f, "utf8")]);
    const w2 = run(["--export", zip, "--backup", backup, "--origin", ORIGIN, "--write"]);
    outputs.push(w2.out, w2.err);
    expect(w2.code).toBe(0);
    expect(w2.out).toContain("to add: 0");
    expect(w2.out).toContain("0 raw item(s) written");
    expect(filesUnder(backup).map((f) => [f, readFileSync(f, "utf8")])).toEqual(stamp);

    // Nothing personal or unpublished anywhere.
    for (const text of [...outputs, ...filesUnder(backup).map((f) => readFileSync(f, "utf8")), readFileSync(hosts, "utf8")]) {
      expect(text).not.toContain(CANARY);
      expect(text).not.toContain("canary");
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain("draft-slug-x");
      expect(text).not.toContain("adhoc-slug-x");
      expect(text).not.toContain("paid-draft-x");
      expect(text).not.toContain("A draft");
    }

    // The real build over the backup.
    const out = join(dir, "site");
    const b = spawnSync(process.execPath, [buildBin, "--backup", backup, "--out", out], { encoding: "utf8", env: { PATH: process.env["PATH"] ?? "", ...ENV } });
    expect(b.status, b.stderr).toBe(0);
    expect(b.stderr).not.toContain("warning");
    const index = JSON.parse(readFileSync(join(out, "index.json"), "utf8")) as { posts: { slug: string; title: string; date: string }[] };
    expect(index.posts.map((p) => p.slug)).toEqual(["existing-post", "first-post", "second-post"]);
    expect(index.posts.map((p) => p.date)).toEqual(["2026-03-10T09:00:00.000Z", "2026-03-02T10:00:00.000Z", "2026-03-01T08:30:00.000Z"]);
    expect(index.posts[2]?.title).toBe('Quoted "title", with\na line break');
    const post = JSON.parse(readFileSync(join(out, "posts", "first-post.json"), "utf8")) as { html: string; unlocalized: number; sourceUrl: string };
    expect(post.sourceUrl).toBe(`${ORIGIN}/p/first-post`);
    expect(post.html).not.toMatch(/<button|<svg/);
    expect(post.unlocalized).toBeGreaterThan(0);
    const second = JSON.parse(readFileSync(join(out, "posts", "second-post.json"), "utf8")) as { excerpt: string };
    expect(second.excerpt).toContain("]]>");
  });

  it("takes the origin from the configuration when --origin is not given", () => {
    const dir = fresh("config");
    const zip = join(dir, "export.zip");
    writeFileSync(zip, makeZip());
    const r = run(["--export", zip, "--backup", join(dir, "b"), "--write"]);
    expect(r.code).toBe(0);
    expect(readFileSync(join(dir, "b", "raw", "first-post.xml"), "utf8")).toContain(`<link>${ORIGIN}/p/first-post</link>`);
  });

  it("refuses an origin that is not https, and missing options", () => {
    const dir = fresh("usage");
    const zip = join(dir, "export.zip");
    writeFileSync(zip, makeZip());
    expect(run(["--export", zip, "--backup", dir, "--origin", "http://example.substack.com"]).code).toBe(2);
    expect(run(["--export", zip]).code).toBe(2);
    expect(run(["--bogus"]).code).toBe(2);
  });

  it("exits non-zero on a malformed export and writes nothing", () => {
    const dir = fresh("bad");
    const backup = join(dir, "b");
    const cases: Record<string, Uint8Array> = {
      "not a zip": enc("this is not a zip"),
      "no posts.csv": zipSync({ "posts/1.x.html": enc("<p>x</p>") }),
      "wrong header": zipSync({ "posts.csv": enc("a,b\n1,2\n") }),
      "unterminated quote": zipSync({ "posts.csv": enc(`${HEADER}\n1,"oops\n`) }),
      "short row": zipSync({ "posts.csv": enc(`${HEADER}\n1,2\n`) }),
      "invalid utf-8": zipSync({ "posts.csv": new Uint8Array([0xff, 0xfe, 0xfd]) }),
    };
    for (const [name, data] of Object.entries(cases)) {
      const zip = join(dir, "bad.zip");
      writeFileSync(zip, data);
      const r = run(["--export", zip, "--backup", backup, "--origin", ORIGIN, "--write"]);
      expect(r.code, name).toBe(1);
      expect(r.out + r.err, name).not.toContain(CANARY);
    }
    expect(run(["--export", join(dir, "missing.zip"), "--backup", backup, "--origin", ORIGIN]).code).toBe(1);
    expect(existsSync(join(backup, "raw"))).toBe(false);
  });

  it("refuses an export with an oversized entry before inflating it", () => {
    const dir = fresh("big");
    const zip = join(dir, "big.zip");
    // 21 MB of zeros compresses to a few KB; the entry is above the 20 MB cap.
    writeFileSync(zip, zipSync({ "posts.csv": enc(`${HEADER}\n`), "posts/1.big.html": new Uint8Array(21 * 1024 * 1024) }));
    const r = run(["--export", zip, "--backup", join(dir, "b"), "--origin", ORIGIN, "--write"]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/too large/);
    expect(existsSync(join(dir, "b"))).toBe(false);
  });
});
