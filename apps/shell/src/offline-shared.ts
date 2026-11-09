// Naming and routing rules shared by the page and the service worker.
// Project Pages sites share one origin with all of their owner's other sites, so
// every cache name and database name carries a prefix taken from the base path,
// and cleanup only ever touches that prefix.

export const DEFAULT_CAP_BYTES = 50 * 1024 * 1024;

/** `https://host/repo/` gives `/repo/`. */
export function scopePath(scopeUrl: string): string {
  return new URL(scopeUrl).pathname;
}

export function cachePrefix(path: string): string {
  return `substacker:${path}:`;
}

export const shellCacheName = (prefix: string, buildId: string) => `${prefix}shell-${buildId}`;
export const contentCacheName = (prefix: string) => `${prefix}content`;
export const databaseName = (prefix: string) => `${prefix}meta`;

export type RequestKind = "revalidate" | "post" | "image";

/**
 * How the service worker treats a request, by path under the shell's scope.
 * `index.json`, `search.json` and `config.json` are stale-while-revalidate, posts
 * are cached when opened, images when first used. Anything else is not handled here.
 */
export function classify(pathname: string, scope: string): RequestKind | null {
  if (!pathname.startsWith(scope)) return null;
  const rest = pathname.slice(scope.length);
  if (rest.startsWith("assets/")) return null;
  if (/(^|\/)(index|search)\.json$/.test(rest) || rest === "config.json") return "revalidate";
  if (/(^|\/)posts\/[^/]+\.json$/.test(rest)) return "post";
  if (/(^|\/)images\/[^/]+$/.test(rest)) return "image";
  return null;
}

/** Parse the cap the page passes in the worker's address; fall back to the default. */
export function capFromSearch(search: string): number {
  const raw = new URLSearchParams(search).get("cap");
  const n = raw === null ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_CAP_BYTES;
}

/**
 * Whether a page navigation is to the shell itself: the scope, or its `index.html`. Only
 * those get the cached shell. On a site served from the root, every other path on the origin
 * belongs to something else and must reach the network untouched.
 */
export function isShellNavigation(pathname: string, scope: string): boolean {
  return pathname === scope || pathname === `${scope}index.html`;
}
