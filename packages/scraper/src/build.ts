import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { imageFilesByKey } from "substacker-core";
import type { Post } from "substacker-core";
import type { DeriveOptions } from "./derive.js";
import { buildIndex, derivePost } from "./derive.js";
import type { Config } from "./config.js";

/** Served files by path relative to the served content root. */
export type Files = Map<string, string | Uint8Array>;

export interface BuildResult {
  files: Files;
  warnings: string[];
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/**
 * Derive every served file from the backup and the configuration. A pure function
 * of its inputs: the same backup and configuration give identical files.
 */
export function build(config: Config, backupDir: string, opts: DeriveOptions = {}): BuildResult {
  const rawDir = join(backupDir, "raw");
  const imagesDir = join(backupDir, "images");
  const imageNames = existsSync(imagesDir) ? readdirSync(imagesDir).sort() : [];
  const present = imageFilesByKey(imageNames);
  const slugs = existsSync(rawDir) ? readdirSync(rawDir).filter((f) => f.endsWith(".xml")).map((f) => f.slice(0, -4)).sort() : [];

  const files: Files = new Map();
  const posts: Post[] = [];
  const skipped: string[] = [];
  for (const slug of slugs) {
    // One raw file that cannot be derived (an old item, or a later policy change) must
    // not brick the site: leave it out and say so. The backup file stays untouched.
    let post: Post;
    try {
      post = derivePost(readFileSync(join(rawDir, `${slug}.xml`), "utf8"), present, opts);
    } catch (e) {
      skipped.push(`skipped raw/${slug}.xml: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    posts.push(post);
    files.set(`posts/${post.slug}.json`, json(post));
  }
  const built = buildIndex(posts, config.hidden, config.feedName);
  const { index, docs } = built;
  const warnings = [...skipped, ...built.warnings];
  files.set("index.json", json(index));
  files.set("search.json", json(docs));
  for (const name of imageNames) files.set(`images/${name}`, readFileSync(join(imagesDir, name)));
  return { files, warnings };
}
