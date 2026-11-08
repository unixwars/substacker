import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BackupReader, Change } from "./scrape.js";

/** The backup on disk: `raw/<slug>.xml` and `images/<name>`. */
export function diskBackup(dir: string): BackupReader {
  const rawDir = join(dir, "raw");
  return {
    slugs: () => (existsSync(rawDir) ? readdirSync(rawDir).filter((f) => f.endsWith(".xml")).map((f) => f.slice(0, -4)).sort() : []),
    readRaw: (slug) => {
      const file = join(rawDir, `${slug}.xml`);
      return existsSync(file) ? readFileSync(file, "utf8") : undefined;
    },
    hasImage: (name) => existsSync(join(dir, "images", name)),
  };
}

function write(file: string, data: string | Uint8Array): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, data);
}

/** Apply scrape changes to the backup directory. */
export function writeChanges(dir: string, changes: readonly Change[]): void {
  for (const c of changes) {
    if (c.kind === "raw") write(join(dir, "raw", `${c.slug}.xml`), c.content);
    else write(join(dir, "images", c.name), c.data);
  }
}

export { write as writeFileDeep };
