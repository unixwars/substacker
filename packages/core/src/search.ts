import MiniSearch from "minisearch";
import type { Doc } from "./contract.js";

export interface Searcher {
  /** Slugs, best match first. An empty query returns nothing. */
  query(q: string): string[];
}

/** Strip diacritics so "cafe" finds "Café". */
const normalize = (term: string) => term.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

export function createSearcher(docs: readonly Doc[]): Searcher {
  const mini = new MiniSearch<Doc>({
    idField: "slug",
    fields: ["title", "text"],
    processTerm: normalize,
    searchOptions: { boost: { title: 3 }, prefix: true, fuzzy: 0.2, processTerm: normalize },
  });
  mini.addAll([...docs]);
  return {
    query(q) {
      if (q.trim() === "") return [];
      return mini.search(q).map((r) => String(r.id));
    },
  };
}

export interface CacheEntry {
  key: string;
  bytes: number;
  lastOpened: number;
}

/**
 * Keys to remove so the total fits in `capBytes`: least recently opened first,
 * stopping as soon as the rest fits. Pure; ties break by key.
 */
export function evictionOrder(entries: readonly CacheEntry[], capBytes: number): string[] {
  let total = entries.reduce((sum, e) => sum + e.bytes, 0);
  if (total <= capBytes) return [];
  const oldestFirst = [...entries].sort((a, b) => a.lastOpened - b.lastOpened || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const evict: string[] = [];
  for (const e of oldestFirst) {
    if (total <= capBytes) break;
    evict.push(e.key);
    total -= e.bytes;
  }
  return evict;
}
