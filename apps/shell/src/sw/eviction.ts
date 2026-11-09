import { evictionOrder } from "substacker-core";
import type { CacheEntry } from "substacker-core";

/**
 * Keys to evict. Entries carry the time of the post open they belong to (images
 * inherit the time of the post being read), so the group opened last is never
 * evicted, even when it alone exceeds the cap.
 */
export function planEviction(entries: readonly CacheEntry[], capBytes: number): string[] {
  if (entries.length === 0) return [];
  const latest = Math.max(...entries.map((e) => e.lastOpened));
  const protectedKeys = new Set(entries.filter((e) => e.lastOpened === latest).map((e) => e.key));
  return evictionOrder(entries, capBytes).filter((k) => !protectedKeys.has(k));
}
