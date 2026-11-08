// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { CONTRACT_VERSION } from "./contract.js";
import { useFeedIndex, usePost, useSearch } from "./react.js";
import { fakeFetch, renderHook } from "./test-support/render-hook.js";

const entry = (slug: string, title = slug) => ({ slug, title, date: "2026-01-01T00:00:00Z", excerpt: "", cover: null });
const index = { version: CONTRACT_VERSION, title: "Example", posts: [entry("c"), entry("b", "Tomato soup"), entry("a")] };
const post = (slug: string) => ({
  version: CONTRACT_VERSION, ...entry(slug), html: "<p>x</p>", sourceUrl: `https://example.substack.com/p/${slug}`,
  contentHash: "h", unlocalized: 0,
});
const docs = [
  { slug: "c", title: "Gardens", text: "basil" },
  { slug: "b", title: "Tomato soup", text: "a recipe" },
  { slug: "hidden-one", title: "Tomato secret", text: "tomato" }, // not in the index
];
const BASE = "https://site.example/content";

describe("useFeedIndex", () => {
  it("goes from loading to ready", async () => {
    const { fn } = fakeFetch({ [`${BASE}/index.json`]: index });
    const h = await renderHook(() => useFeedIndex(BASE, fn), undefined);
    expect(h.result.current.status === "loading" || h.result.current.status === "ready").toBe(true);
    await h.settle();
    const r = h.result.current;
    expect(r.status).toBe("ready");
    if (r.status === "ready") expect(r.index.posts).toHaveLength(3);
  });
  it("reports a network error", async () => {
    const fn = (async () => { throw new TypeError("offline"); }) as typeof fetch;
    const h = await renderHook(() => useFeedIndex(BASE, fn), undefined);
    await h.settle();
    const r = h.result.current;
    expect(r.status).toBe("error");
    if (r.status === "error") expect(r.reason).toBe("network");
  });
  it("reports a server error", async () => {
    const { fn } = fakeFetch({ [`${BASE}/index.json`]: () => new Response("boom", { status: 500 }) });
    const h = await renderHook(() => useFeedIndex(BASE, fn), undefined);
    await h.settle();
    const r = h.result.current;
    expect(r.status === "error" && r.reason).toBe("network");
  });
  it("reports a malformed payload", async () => {
    const { fn } = fakeFetch({ [`${BASE}/index.json`]: { version: 1 } });
    const h = await renderHook(() => useFeedIndex(BASE, fn), undefined);
    await h.settle();
    const r = h.result.current;
    expect(r.status === "error" && r.reason).toBe("malformed");
  });
  it("reports a newer contract as unsupported", async () => {
    const { fn } = fakeFetch({ [`${BASE}/index.json`]: { version: CONTRACT_VERSION + 1 } });
    const h = await renderHook(() => useFeedIndex(BASE, fn), undefined);
    await h.settle();
    expect(h.result.current.status).toBe("unsupported");
  });
  it("accepts a base with a trailing slash", async () => {
    const { fn, calls } = fakeFetch({ [`${BASE}/index.json`]: index });
    const h = await renderHook(() => useFeedIndex(`${BASE}/`, fn), undefined);
    await h.settle();
    expect(calls).toEqual([`${BASE}/index.json`]);
  });
});

describe("useSearch", () => {
  const routes = { [`${BASE}/index.json`]: index, [`${BASE}/search.json`]: docs };
  it("does not fetch the search file for an empty query", async () => {
    const { fn, calls } = fakeFetch(routes);
    const h = await renderHook((q: string) => useSearch(BASE, q, fn), "" as string);
    await h.settle();
    const r = h.result.current;
    expect(r.status).toBe("ready");
    if (r.status === "ready") expect(r.results).toEqual([]);
    expect(calls.some((c) => c.endsWith("search.json"))).toBe(false);
  });
  it("returns index entries for matches and leaves out slugs not in the index", async () => {
    const { fn } = fakeFetch(routes);
    const h = await renderHook((q: string) => useSearch(BASE, q, fn), "tomato" as string);
    await h.settle();
    await h.settle();
    const r = h.result.current;
    expect(r.status).toBe("ready");
    if (r.status === "ready") expect(r.results.map((e) => e.slug)).toEqual(["b"]);
  });
  it("answers a changed query without fetching again", async () => {
    const { fn, calls } = fakeFetch(routes);
    const h = await renderHook((q: string) => useSearch(BASE, q, fn), "tomato" as string);
    await h.settle();
    await h.rerender("garden");
    await h.settle();
    const r = h.result.current;
    if (r.status === "ready") expect(r.results.map((e) => e.slug)).toEqual(["c"]);
    expect(calls.filter((c) => c.endsWith("search.json"))).toHaveLength(1);
  });
  it("reports a network error", async () => {
    const { fn } = fakeFetch({ [`${BASE}/index.json`]: index });
    const h = await renderHook((q: string) => useSearch(BASE, q, fn), "tomato" as string);
    await h.settle();
    await h.settle();
    expect(h.result.current.status).toBe("error");
  });
  it("reports a malformed search file", async () => {
    const { fn } = fakeFetch({ [`${BASE}/index.json`]: index, [`${BASE}/search.json`]: { nope: true } });
    const h = await renderHook((q: string) => useSearch(BASE, q, fn), "tomato" as string);
    await h.settle();
    await h.settle();
    const r = h.result.current;
    expect(r.status === "error" && r.reason).toBe("malformed");
  });
});

describe("usePost", () => {
  const routes = { [`${BASE}/index.json`]: index, [`${BASE}/posts/b.json`]: post("b") };
  it("loads a post with its neighbours", async () => {
    const { fn } = fakeFetch(routes);
    const h = await renderHook((slug: string) => usePost(BASE, slug, fn), "b" as string);
    await h.settle();
    await h.settle();
    const r = h.result.current;
    expect(r.status).toBe("ready");
    if (r.status === "ready") {
      expect(r.post.slug).toBe("b");
      expect(r.previous?.slug).toBe("c");
      expect(r.next?.slug).toBe("a");
    }
  });
  it("treats a slug that is not in the index as not found, without fetching the post", async () => {
    const { fn, calls } = fakeFetch({ ...routes, [`${BASE}/posts/hidden-one.json`]: post("hidden-one") });
    const h = await renderHook((slug: string) => usePost(BASE, slug, fn), "hidden-one" as string);
    await h.settle();
    await h.settle();
    const r = h.result.current;
    expect(r.status).toBe("error");
    if (r.status === "error") expect(r.reason).toBe("not-found");
    expect(calls.some((c) => c.includes("posts/"))).toBe(false);
  });
  it("reports not found when the post file is missing", async () => {
    const { fn } = fakeFetch({ [`${BASE}/index.json`]: index });
    const h = await renderHook((slug: string) => usePost(BASE, slug, fn), "a" as string);
    await h.settle();
    await h.settle();
    const r = h.result.current;
    expect(r.status === "error" && r.reason).toBe("not-found");
  });
  it("reports a malformed post", async () => {
    const { fn } = fakeFetch({ [`${BASE}/index.json`]: index, [`${BASE}/posts/a.json`]: { version: 1, slug: "a" } });
    const h = await renderHook((slug: string) => usePost(BASE, slug, fn), "a" as string);
    await h.settle();
    await h.settle();
    const r = h.result.current;
    expect(r.status === "error" && r.reason).toBe("malformed");
  });
  it("reports a newer post as unsupported", async () => {
    const { fn } = fakeFetch({ [`${BASE}/index.json`]: index, [`${BASE}/posts/a.json`]: { ...post("a"), version: CONTRACT_VERSION + 1 } });
    const h = await renderHook((slug: string) => usePost(BASE, slug, fn), "a" as string);
    await h.settle();
    await h.settle();
    expect(h.result.current.status).toBe("unsupported");
  });
  it("goes back to loading when the slug changes", async () => {
    const { fn } = fakeFetch({ ...routes, [`${BASE}/posts/c.json`]: post("c") });
    const h = await renderHook((slug: string) => usePost(BASE, slug, fn), "b" as string);
    await h.settle();
    await h.settle();
    await h.rerender("c");
    await h.settle();
    await h.settle();
    const r = h.result.current;
    expect(r.status === "ready" && r.post.slug).toBe("c");
  });
  it("encodes the slug in the address", async () => {
    const slug = "café";
    const { fn, calls } = fakeFetch({
      [`${BASE}/index.json`]: { ...index, posts: [entry(slug)] },
      [`${BASE}/posts/${encodeURIComponent(slug)}.json`]: post(slug),
    });
    const h = await renderHook(() => usePost(BASE, slug, fn), undefined);
    await h.settle();
    await h.settle();
    expect(h.result.current.status).toBe("ready");
    expect(calls).toContain(`${BASE}/posts/caf%C3%A9.json`);
  });
});
