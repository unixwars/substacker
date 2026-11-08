import { createHash } from "node:crypto";

/**
 * The worker's build id: a hash of the names and the contents of every file it precaches.
 * A changed manifest or icon (same name, new bytes) must change `sw.js`, or browsers would
 * keep the old worker and its old caches.
 */
export function buildId(files: ReadonlyMap<string, Uint8Array>): string {
  const hash = createHash("sha256");
  for (const name of [...files.keys()].sort()) {
    const data = files.get(name) as Uint8Array;
    // Lengths up front, so where one file ends and the next begins is part of the hash.
    hash.update(`${Buffer.byteLength(name)}:${name}:${data.byteLength}:`).update(data);
  }
  return hash.digest("hex").slice(0, 12);
}
