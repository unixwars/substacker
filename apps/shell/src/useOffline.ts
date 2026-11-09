import { useEffect, useState } from "react";
import { cachePrefix, contentCacheName } from "./offline-shared.js";

/**
 * Addresses currently stored for offline reading by this shell's worker. Re-read
 * when `refreshKey` changes and shortly after, since the worker stores a post
 * just after it is served.
 */
export function useOfflineKeys(refreshKey: string): Set<string> {
  const [keys, setKeys] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!("caches" in window)) return;
    let cancelled = false;
    const read = async () => {
      const path = new URL(".", document.baseURI).pathname;
      const cache = await caches.open(contentCacheName(cachePrefix(path)));
      const found = new Set((await cache.keys()).map((r) => r.url));
      if (!cancelled) setKeys(found);
    };
    void read();
    const timers = [setTimeout(read, 300), setTimeout(read, 1500)];
    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
    };
  }, [refreshKey]);
  return keys;
}

export const postUrl = (base: string, slug: string) => `${base.replace(/\/+$/, "")}/posts/${encodeURIComponent(slug)}.json`;
