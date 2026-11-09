import { unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import {
  BackfillError,
  buildBackfillItem,
  classifyEntry,
  countImageHosts,
  createEntryFilter,
  MAX_ENTRY_BYTES,
  MAX_TOTAL_BYTES,
  parseCsv,
  parsePostsCsv,
  pubDateOf,
  selectRows,
  SOURCE_MARKER,
  type PostRow,
} from "./backfill.js";
import { derivePost } from "./derive.js";
import { hashRaw, parseFeed, parseItem } from "./feed.js";

const ORIGIN = "https://example.substack.com";
const CDN = "https://substackcdn.com/image/fetch/$s_!abcd!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/";
const S3 = "https://substack-post-media.s3.amazonaws.com/public/images/11111111-1111-4111-8111-111111111111_1200x800.jpeg";
const fetchUrl = (w: number) => `${CDN.replace("w_1456", `w_${w}`)}${encodeURIComponent(S3)}`;

const row = (over: Partial<PostRow> = {}): PostRow => ({
  post_id: "1",
  post_date: "2026-03-02T10:00:00.000Z",
  is_published: "true",
  email_sent_at: "",
  inbox_sent_at: "",
  type: "newsletter",
  audience: "everyone",
  title: "Hello, world",
  subtitle: "A placeholder subtitle.",
  podcast_url: "",
  ...over,
});

describe("parseCsv", () => {
  it("reads plain rows with LF and CRLF line ends and no trailing empty row", () => {
    expect(parseCsv("a,b\n1,2\n")).toEqual([["a", "b"], ["1", "2"]]);
    expect(parseCsv("a,b\r\n1,2\r\n3,4")).toEqual([["a", "b"], ["1", "2"], ["3", "4"]]);
  });
  it("reads quoted fields with commas, doubled quotes and newlines", () => {
    expect(parseCsv('a,b\n"x, y","say ""hi"""\n"line1\nline2",z\n')).toEqual([["a", "b"], ["x, y", 'say "hi"'], ["line1\nline2", "z"]]);
  });
  it("keeps empty fields and strips a leading byte order mark", () => {
    expect(parseCsv("﻿a,b,c\n,,\n")).toEqual([["a", "b", "c"], ["", "", ""]]);
  });
  it("throws on an unterminated quote without echoing the content", () => {
    expect(() => parseCsv('a\n"secret value')).toThrow(BackfillError);
    expect(() => parseCsv('a\n"secret value')).not.toThrow(/secret/);
  });
  it("throws on a quote in the middle of an unquoted field", () => {
    expect(() => parseCsv('a\nx"y\n')).toThrow(BackfillError);
  });
  it("returns no rows for empty text", () => {
    expect(parseCsv("")).toEqual([]);
  });
});

describe("parsePostsCsv", () => {
  const header = "post_id,post_date,is_published,email_sent_at,inbox_sent_at,type,audience,title,subtitle,podcast_url";
  it("returns records keyed by the header", () => {
    const rows = parsePostsCsv(`${header}\n7,2026-03-02T10:00:00.000Z,true,,,newsletter,everyone,"A, B","Line\nbreak",\n`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ post_id: "7", title: "A, B", subtitle: "Line\nbreak", audience: "everyone" });
  });
  it("throws when a required column is missing", () => {
    expect(() => parsePostsCsv("post_id,title\n1,x\n")).toThrow(/column/);
  });
  it("throws when a row has the wrong number of fields", () => {
    expect(() => parsePostsCsv(`${header}\n1,2\n`)).toThrow(BackfillError);
  });
});

describe("classifyEntry", () => {
  it("allows posts.csv", () => {
    expect(classifyEntry("posts.csv")).toEqual({ kind: "posts-csv" });
  });
  it("allows posts/<id>.<slug>.html and returns id and slug", () => {
    expect(classifyEntry("posts/42.hello-world.html")).toEqual({ kind: "post-html", id: "42", slug: "hello-world" });
    expect(classifyEntry("posts/42.a.b.html")).toEqual({ kind: "post-html", id: "42", slug: "a.b" });
    expect(classifyEntry("posts/7.caf%C3%A9-ünï.html")).toMatchObject({ kind: "post-html", id: "7" });
  });
  it("refuses personal data and everything else", () => {
    for (const name of [
      "email_list.example.csv",
      "email_list.csv",
      "posts/1.delivers.csv",
      "posts/1.opens.csv",
      "posts/1.hello.html.csv",
      "posts/hello.html",
      "posts/.html",
      "posts/1..html",
      "posts/1.x/y.html",
      "posts/sub/1.x.html",
      "../posts.csv",
      "/posts.csv",
      "posts.csv/",
      "posts/",
      "posts/1.x.html/",
      "Posts.csv",
      "a/posts.csv",
      "",
    ]) {
      expect(classifyEntry(name), name).toBeNull();
    }
  });
  it("refuses backslashes, NUL, control characters and very long names", () => {
    expect(classifyEntry("posts\\1.x.html")).toBeNull();
    expect(classifyEntry("posts/1.x\0.html")).toBeNull();
    expect(classifyEntry("posts/1.x\n.html")).toBeNull();
    expect(classifyEntry(`posts/1.${"a".repeat(300)}.html`)).toBeNull();
  });
  it("marks an html entry whose slug is not a safe file name", () => {
    expect(classifyEntry("posts/5...html")).toEqual({ kind: "post-html", id: "5", slug: "." });
  });
});

describe("createEntryFilter", () => {
  const info = (name: string, originalSize = 10) => ({ name, size: originalSize, originalSize, compression: 8 });

  it("accepts only the allowed entries and records the ids of html files with an unsafe slug", () => {
    const f = createEntryFilter();
    expect(f.filter(info("posts.csv"))).toBe(true);
    expect(f.filter(info("posts/1.good.html"))).toBe(true);
    expect(f.filter(info("posts/2...html"))).toBe(false);
    expect(f.filter(info("posts/1.delivers.csv"))).toBe(false);
    expect(f.filter(info("email_list.example.csv"))).toBe(false);
    expect(f.unsafeIds).toEqual(new Set(["2"]));
    expect(f.problems).toEqual([]);
  });
  it("refuses an entry above the per-entry cap and reports it by id, not by content", () => {
    const f = createEntryFilter();
    expect(f.filter(info("posts/3.big.html", MAX_ENTRY_BYTES + 1))).toBe(false);
    expect(f.problems).toHaveLength(1);
    expect(f.problems[0]).toMatch(/too large/);
  });
  it("refuses entries once the total cap is reached", () => {
    const f = createEntryFilter();
    const n = Math.floor(MAX_TOTAL_BYTES / MAX_ENTRY_BYTES);
    for (let i = 0; i < n; i++) expect(f.filter(info(`posts/${i}.x.html`, MAX_ENTRY_BYTES))).toBe(true);
    expect(f.filter(info("posts/999.x.html", MAX_ENTRY_BYTES))).toBe(false);
    expect(f.problems.some((p) => /total/.test(p))).toBe(true);
  });
  it("flags a second html entry for the same id", () => {
    const f = createEntryFilter();
    expect(f.filter(info("posts/1.a.html"))).toBe(true);
    expect(f.filter(info("posts/1.b.html"))).toBe(false);
    expect(f.problems.some((p) => /more than one/.test(p))).toBe(true);
  });

  it("keeps personal-data entries out of a real unzip", () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    const zip = zipSync({
      "posts.csv": enc("post_id\n1\n"),
      "posts/1.hello.html": enc("<p>hi</p>"),
      "email_list.example.csv": enc("canary@example.invalid\n"),
      "posts/1.delivers.csv": enc("canary@example.invalid,x\n"),
      "posts/1.opens.csv": enc("canary@example.invalid,y\n"),
    });
    const out = unzipSync(zip, { filter: createEntryFilter().filter });
    expect(Object.keys(out).sort()).toEqual(["posts.csv", "posts/1.hello.html"]);
    expect(Object.values(out).map((b) => new TextDecoder().decode(b)).join("")).not.toContain("canary");
  });
});

describe("pubDateOf", () => {
  it("formats an ISO date as RFC 822 in UTC like the feed", () => {
    expect(pubDateOf("2026-03-02T10:00:00.000Z")).toBe("Mon, 02 Mar 2026 10:00:00 GMT");
    expect(pubDateOf("2026-03-02T12:00:00+02:00")).toBe("Mon, 02 Mar 2026 10:00:00 GMT");
  });
  it("returns null for text that is not a date", () => {
    expect(pubDateOf("")).toBeNull();
    expect(pubDateOf("yesterday")).toBeNull();
  });
});

describe("selectRows", () => {
  const html = (id: string, slug: string) => [id, { slug, html: "<p>x</p>" }] as const;
  it("adds eligible rows and counts every skipped row with a reason", () => {
    const rows = [
      row({ post_id: "1" }),
      row({ post_id: "2", is_published: "false" }),
      row({ post_id: "3", type: "adhoc_email", is_published: "false" }),
      row({ post_id: "4", audience: "only_paid" }),
      row({ post_id: "5", type: "podcast" }),
      row({ post_id: "6" }),
      row({ post_id: "7" }),
      row({ post_id: "8" }),
      row({ post_id: "9", post_date: "not a date" }),
    ];
    const htmlById = new Map([html("1", "one"), html("2", "two"), html("3", "three"), html("4", "four"), html("5", "five"), html("8", "eight"), html("9", "nine")]);
    const sel = selectRows(rows, htmlById, new Set(["6"]), new Set(["eight"]));
    expect(sel.add.map((c) => c.slug)).toEqual(["one"]);
    expect(sel.skipped).toEqual([
      { id: "2", reason: "unpublished" },
      { id: "3", reason: "unpublished" },
      { id: "4", slug: "four", reason: "not-everyone" },
      { id: "5", slug: "five", reason: "not-newsletter" },
      { id: "6", reason: "unsafe-slug" },
      { id: "7", reason: "no-html" },
      { id: "8", slug: "eight", reason: "already-present" },
      { id: "9", slug: "nine", reason: "bad-date" },
    ]);
  });
  it("counts a row with no html file", () => {
    const sel = selectRows([row({ post_id: "7" })], new Map(), new Set(), new Set());
    expect(sel.add).toEqual([]);
    expect(sel.skipped).toEqual([{ id: "7", reason: "no-html" }]);
  });
  it("orders additions oldest first and carries the fields the item needs", () => {
    const rows = [row({ post_id: "1", post_date: "2026-03-05T00:00:00.000Z" }), row({ post_id: "2", post_date: "2026-03-01T00:00:00.000Z", title: "T", subtitle: "" })];
    const sel = selectRows(rows, new Map([html("1", "b"), html("2", "a")]), new Set(), new Set());
    expect(sel.add.map((c) => c.slug)).toEqual(["a", "b"]);
    expect(sel.add[0]).toMatchObject({ id: "2", title: "T", subtitle: "", date: "2026-03-01T00:00:00.000Z" });
  });
  it("adds a slug only once", () => {
    const sel = selectRows([row({ post_id: "1" }), row({ post_id: "2" })], new Map([html("1", "same"), html("2", "same")]), new Set(), new Set());
    expect(sel.add).toHaveLength(1);
    expect(sel.skipped).toEqual([{ id: "2", slug: "same", reason: "already-present" }]);
  });
});

const cand = (over: Record<string, string> = {}) => ({
  id: "1001",
  slug: "hello-world",
  title: "Hello, world",
  subtitle: "A placeholder subtitle.",
  date: "2026-03-02T10:00:00.000Z",
  html: `<p>Text</p><div><picture><source type="image/webp" srcset="${fetchUrl(424)} 424w, ${fetchUrl(848)} 848w"><img src="${fetchUrl(1456)}"></picture></div>`,
  ...over,
});
const wrap = (item: string) => `<?xml version="1.0"?><rss xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:substacker="urn:substacker" version="2.0"><channel><title>T</title>${item}</channel></rss>`;

describe("buildBackfillItem", () => {
  it("round-trips through parseFeed and stores exactly the serialization parseFeed returns", () => {
    const raw = buildBackfillItem(cand(), ORIGIN);
    const items = parseFeed(wrap(raw));
    expect(items).toHaveLength(1);
    expect(items[0]?.raw).toBe(raw);
    expect(items[0]?.slug).toBe("hello-world");
  });
  it("has the shape of the real feed's items", () => {
    const item = parseItem(buildBackfillItem(cand(), ORIGIN));
    expect(item).toMatchObject({
      slug: "hello-world",
      title: "Hello, world",
      link: "https://example.substack.com/p/hello-world",
      date: "2026-03-02T10:00:00.000Z",
      description: "A placeholder subtitle.",
    });
    expect(item.html).toContain("<picture>");
  });
  it("uses post:<id> as the guid like the real feed and puts the pubDate in RFC 822", () => {
    const raw = buildBackfillItem(cand(), ORIGIN);
    expect(raw).toContain('<guid isPermaLink="false">post:1001</guid>');
    expect(raw).toContain("<pubDate>Mon, 02 Mar 2026 10:00:00 GMT</pubDate>");
    expect(raw.startsWith("<item>")).toBe(true);
    expect(raw.endsWith("</item>")).toBe(true);
  });
  it("derives the enclosure from the body's first image, mirroring the cover rule", () => {
    const raw = buildBackfillItem(cand(), ORIGIN);
    expect(parseItem(raw).enclosure).toBe(fetchUrl(1456));
    expect(raw).toMatch(/<enclosure url="[^"]+" length="0" type="image\/jpeg"\/>/);
  });
  it("omits the enclosure when the body has no remote image", () => {
    expect(buildBackfillItem(cand({ html: "<p>No images</p>" }), ORIGIN)).not.toContain("<enclosure");
    expect(buildBackfillItem(cand({ html: '<img src="data:image/png;base64,AAAA">' }), ORIGIN)).not.toContain("<enclosure");
  });
  it("ignores images inside widgets that stripWidgets removes", () => {
    const html = `<p class="button-wrapper"><a href="${ORIGIN}/subscribe?"><img src="https://example.com/btn.png"></a></p><img src="https://example.com/real.png">`;
    expect(parseItem(buildBackfillItem(cand({ html }), ORIGIN)).enclosure).toBe("https://example.com/real.png");
  });
  it("escapes ampersands in an enclosure address", () => {
    const raw = buildBackfillItem(cand({ html: '<img src="https://example.com/a.png?x=1&amp;y=2">' }), ORIGIN);
    expect(raw).toContain('url="https://example.com/a.png?x=1&amp;y=2"');
    expect(parseItem(raw).enclosure).toBe("https://example.com/a.png?x=1&y=2");
  });
  it("leaves the description empty without a subtitle", () => {
    const raw = buildBackfillItem(cand({ subtitle: "" }), ORIGIN);
    expect(raw).toContain("<description><![CDATA[]]></description>");
    expect(parseItem(raw).description).toBe("");
  });
  it("splits ]]> inside CDATA so the text survives", () => {
    const html = "<p>a ]]> b</p><pre>]]></pre>";
    const raw = buildBackfillItem(cand({ title: "x ]]> y", subtitle: "s ]]> t", html }), ORIGIN);
    const item = parseItem(raw);
    expect(item.html).toBe(html);
    expect(item.title).toBe("x ]]> y");
    expect(item.description).toBe("s ]]> t");
    expect(parseFeed(wrap(raw))[0]?.raw).toBe(raw);
  });
  it("keeps a body that contains </item> intact", () => {
    const raw = buildBackfillItem(cand({ html: "<p>&lt;/item&gt; </item> text</p>" }), ORIGIN);
    expect(parseFeed(wrap(raw))).toHaveLength(1);
    expect(parseItem(raw).html).toContain("</item>");
  });
  it("drops characters that XML cannot carry", () => {
    const raw = buildBackfillItem(cand({ html: "<p>a\u0000b\u0008c\u000Bd</p>" }), ORIGIN);
    expect(parseItem(raw).html).toBe("<p>abcd</p>");
  });
  it("encodes a non-ASCII slug in the link and reads it back", () => {
    const raw = buildBackfillItem(cand({ slug: "café-ünï" }), ORIGIN);
    expect(raw).toContain("/p/caf%C3%A9-%C3%BCn%C3%AF</link>");
    expect(parseItem(raw).slug).toBe("café-ünï");
  });
  it("rejects an unsafe slug, a bad date and a non-https origin", () => {
    for (const slug of ["", ".", "..", "a/b", "a\\b", "a\0b"]) expect(() => buildBackfillItem(cand({ slug }), ORIGIN), slug).toThrow(BackfillError);
    expect(() => buildBackfillItem(cand({ date: "nope" }), ORIGIN)).toThrow(BackfillError);
    expect(() => buildBackfillItem(cand(), "http://example.substack.com")).toThrow(BackfillError);
  });

  describe("provenance marker", () => {
    it("is present and parseFeed accepts it", () => {
      const raw = buildBackfillItem(cand(), ORIGIN);
      expect(raw).toContain(SOURCE_MARKER);
      expect(raw).toContain("<substacker:source>export</substacker:source>");
      expect(parseFeed(wrap(raw))).toHaveLength(1);
    });
    it("does not change what the build derives, apart from the content hash", () => {
      const raw = buildBackfillItem(cand(), ORIGIN);
      const plain = raw.replace(SOURCE_MARKER, "");
      expect(plain).not.toBe(raw);
      const a = derivePost(raw, new Map());
      const b = derivePost(plain, new Map());
      expect({ ...a, contentHash: "" }).toEqual({ ...b, contentHash: "" });
      expect(a.contentHash).toBe(hashRaw(raw));
    });
  });
});

describe("countImageHosts", () => {
  it("counts hosts of img src, srcset and picture candidates, including the original inside an image/fetch address", () => {
    const html = `<picture><source srcset="${fetchUrl(424)} 424w, ${fetchUrl(848)} 848w"><img src="${fetchUrl(1456)}"></picture><img src="https://images.example.org/a.png"><img src="/relative.png"><img src="data:image/png;base64,AAAA">`;
    const counts = countImageHosts([html]);
    expect(counts.get("substackcdn.com")).toBe(3);
    expect(counts.get("substack-post-media.s3.amazonaws.com")).toBe(3);
    expect(counts.get("images.example.org")).toBe(1);
    expect(counts.has("(relative)")).toBe(true);
    expect(counts.has("(data)")).toBe(true);
  });
  it("adds up over several posts and handles an unencoded original", () => {
    const html = '<img src="https://substackcdn.com/image/fetch/w_100,c_limit/https://bucket.example.org/x.jpg">';
    const counts = countImageHosts([html, html]);
    expect(counts.get("bucket.example.org")).toBe(2);
  });
  it("returns hosts sorted by count then name through sortedHosts", async () => {
    const { sortedHosts } = await import("./backfill.js");
    expect(sortedHosts(new Map([["b", 1], ["a", 1], ["c", 5]]))).toEqual([["c", 5], ["a", 1], ["b", 1]]);
  });
});
