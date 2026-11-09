// Prints the CHANGELOG.md section of one version, for the notes of a GitHub Release:
//
//   node scripts/changelog-section.mjs <tag-or-version> [changelog-file]
//
// For example `node scripts/changelog-section.mjs v0.1.0` prints what is under
// "## [0.1.0] - ..." up to the next "## " heading (without the heading and without the
// link references at the end of the file). Exit codes: 0 printed, 1 the section is
// missing or empty (with a message on stderr), 2 usage.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const normalizeVersion = (value) => value.trim().replace(/^v/, "");

/** The trimmed body of `## [<version>]` in `changelog`, or undefined if missing or empty. */
export function extractSection(changelog, version) {
  const wanted = normalizeVersion(version);
  const lines = changelog.replaceAll("\r\n", "\n").split("\n");
  const start = lines.findIndex((line) => {
    const m = /^##\s+\[([^\]]+)\]/.exec(line);
    return m !== null && m[1] === wanted;
  });
  if (start < 0) return undefined;
  let end = lines.findIndex((line, i) => i > start && /^##\s/.test(line));
  if (end < 0) end = lines.length;
  const body = lines.slice(start + 1, end);
  // Link reference definitions ("[0.1.0]: https://...") trail the last section.
  while (body.length > 0 && /^\s*(\[[^\]]+\]:\s+\S+.*)?$/.test(body[body.length - 1] ?? "")) body.pop();
  const text = body.join("\n").trim();
  return text === "" ? undefined : text;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [version, file] = process.argv.slice(2);
  if (!version) {
    console.error("Usage: node scripts/changelog-section.mjs <tag-or-version> [changelog-file]");
    process.exit(2);
  }
  const path = file ?? join(dirname(fileURLToPath(import.meta.url)), "..", "CHANGELOG.md");
  const section = extractSection(readFileSync(path, "utf8"), version);
  if (section === undefined) {
    console.error(`CHANGELOG.md has no non-empty section "## [${normalizeVersion(version)}]". Add it (see docs/releasing.md) and make a new tag.`);
    process.exit(1);
  }
  console.log(section);
}
