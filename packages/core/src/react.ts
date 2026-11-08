import { useEffect, useMemo, useRef, useState } from "react";
import { ContractError, parseDocs, parseIndex, parsePost } from "./contract.js";
import type { Entry, Index, Post } from "./contract.js";
import { neighbours } from "./post.js";
import { createSearcher } from "./search.js";
import type { Searcher } from "./search.js";

export type FetchFn = typeof fetch;

export type ErrorReason = "network" | "malformed" | "not-found";

/** Headless state: hosts render these however they like. */
export type Loadable<T> =
  | { status: "loading" }
  | ({ status: "ready" } & T)
  | { status: "error"; reason: ErrorReason; error: Error }
  | { status: "unsupported"; error: Error };

class ReaderError extends Error {
  constructor(
    readonly reason: ErrorReason,
    message: string,
  ) {
    super(message);
    this.name = "ReaderError";
  }
}

const joinUrl = (base: string, path: string) => `${base.replace(/\/+$/, "")}/${path}`;

async function fetchJson(fetchFn: FetchFn, url: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchFn(url);
  } catch (e) {
    throw new ReaderError("network", e instanceof Error ? e.message : "network error");
  }
  if (!response.ok) {
    throw new ReaderError(response.status === 404 ? "not-found" : "network", `${url}: HTTP ${response.status}`);
  }
  try {
    return await response.json();
  } catch {
    throw new ReaderError("malformed", `${url}: not JSON`);
  }
}

function toFailure(e: unknown): { status: "error"; reason: ErrorReason; error: Error } | { status: "unsupported"; error: Error } {
  if (e instanceof ContractError) {
    return e.reason === "newer" ? { status: "unsupported", error: e } : { status: "error", reason: "malformed", error: e };
  }
  if (e instanceof ReaderError) return { status: "error", reason: e.reason, error: e };
  const error = e instanceof Error ? e : new Error(String(e));
  return { status: "error", reason: "network", error };
}

/**
 * The newest value, readable from effects without being one of their dependencies. A host
 * that passes an inline `fetch` function gets a new one on every render; as a dependency
 * it would reload (and re-render) forever.
 */
function useLatest<T>(value: T): { readonly current: T } {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

/** Run `load` whenever `deps` change; stale results are ignored. */
function useLoad<T>(load: () => Promise<T>, deps: readonly unknown[], enabled = true): Loadable<{ value: T }> {
  const [state, setState] = useState<Loadable<{ value: T }>>({ status: "loading" });
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setState({ status: "loading" });
    load().then(
      (value) => !cancelled && setState({ status: "ready", value }),
      (e: unknown) => !cancelled && setState(toFailure(e)),
    );
    return () => {
      cancelled = true;
    };
  }, [...deps, enabled]);
  return state;
}

const loadIndex = async (base: string, fetchFn: FetchFn): Promise<Index> =>
  parseIndex(await fetchJson(fetchFn, joinUrl(base, "index.json")));

export function useFeedIndex(base: string, fetchFn: FetchFn = globalThis.fetch): Loadable<{ index: Index }> {
  const latest = useLatest(fetchFn);
  const s = useLoad(() => loadIndex(base, latest.current), [base]);
  return s.status === "ready" ? { status: "ready", index: s.value } : s;
}

export function useSearch(
  base: string,
  query: string,
  fetchFn: FetchFn = globalThis.fetch,
): Loadable<{ results: Entry[] }> {
  const active = query.trim() !== "";
  const latest = useLatest(fetchFn);
  // The index and the search file are fetched on first use, then reused for later queries.
  const data = useLoad(
    async () => {
      const [index, docs] = await Promise.all([
        loadIndex(base, latest.current),
        fetchJson(latest.current, joinUrl(base, "search.json")).then(parseDocs),
      ]);
      return { index, searcher: createSearcher(docs) as Searcher };
    },
    [base],
    active,
  );
  const results = useMemo(() => {
    if (!active || data.status !== "ready") return [];
    const bySlug = new Map(data.value.index.posts.map((p) => [p.slug, p]));
    return data.value.searcher
      .query(query)
      .map((slug) => bySlug.get(slug))
      .filter((e): e is Entry => e !== undefined);
  }, [active, data, query]);

  if (!active) return { status: "ready", results: [] };
  if (data.status === "ready") return { status: "ready", results };
  return data;
}

export function usePost(
  base: string,
  slug: string,
  fetchFn: FetchFn = globalThis.fetch,
): Loadable<{ post: Post; previous?: Entry; next?: Entry }> {
  const latest = useLatest(fetchFn);
  const s = useLoad(
    async () => {
      const index = await loadIndex(base, latest.current);
      if (!index.posts.some((p) => p.slug === slug)) throw new ReaderError("not-found", `no post ${slug}`);
      const post = parsePost(await fetchJson(latest.current, joinUrl(base, `posts/${encodeURIComponent(slug)}.json`)));
      return { post, ...neighbours(index, slug) };
    },
    [base, slug],
  );
  return s.status === "ready" ? { status: "ready", ...s.value } : s;
}

