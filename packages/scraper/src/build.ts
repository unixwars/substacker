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
  for (const slug of slugs) {
    const post = derivePost(readFileSync(join(rawDir, `${slug}.xml`), "utf8"), present, opts);
    posts.push(post);
    files.set(`posts/${post.slug}.json`, json(post));
  }
  const { index, docs, warnings } = buildIndex(posts, config.hidden, config.feedName);
  files.set("index.json", json(index));
  files.set("search.json", json(docs));
  for (const name of imageNames) files.set(`images/${name}`, readFileSync(join(imagesDir, name)));
  return { files, warnings };
}
