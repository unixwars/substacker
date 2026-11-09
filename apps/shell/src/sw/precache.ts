/**
 * The files the service worker stores at install, relative to its scope, from the
 * files a build emitted. Generated at build time because Vite hashes asset names.
 */
export function precacheList(files: readonly string[]): string[] {
  const keep = files
    .map((f) => f.replace(/\\/g, "/").replace(/^\.?\//, ""))
    .filter((f) => !f.endsWith(".map"))
    .filter((f) => f !== "sw.js" && f !== "config.json" && !f.startsWith("content/"))
    .sort();
  return [...new Set(["./", ...keep])];
}
