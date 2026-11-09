// One-off: backfill older posts from a Substack data export (a zip) into the backup layout,
// one synthesized feed item per post as `raw/<slug>.xml`. The daily scrape then downloads
// the missing images for the stored items and `build` derives everything, unchanged.
//
//   node scripts/backfill-export.mjs --export <zip> --backup <dir> [--origin <https origin>]
//                                    [--write] [--hosts-json <path>] [--version]
//
//   --export       the export zip (Substack: Settings, Exports)
//   --backup       the backup directory (a clone of `content`); `raw/` is created in it
//   --origin       the publication's https origin for the links; default: the origin of the
//                  configured `feedUrl` (SUBSTACKER_CONFIG or substacker.config.local.json)
//   --write        write the files. Without it this is a dry run: the plan is printed, nothing is written
//   --hosts-json   also write the image host counts to <path> (written in a dry run too)
//
// PRIVACY: an export holds subscriber addresses and per-recipient data. This script opens only
// `posts.csv` and `posts/<id>.<slug>.html` (see `classifyEntry` in the scraper); every other
// entry is refused before it is inflated, never read, never logged. Names from the export are
// never used as file names: the slug is checked first. Needs no network. Run `npm run build` first.
//
// Never overwrites a file in `raw/` (the real feed's items win), never deletes. Exit codes:
// 0 done, 1 failure (malformed export, unreadable required entry, refused write), 2 usage.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";
import { packageVersion, readIfExists, scraperModule } from "./site.mjs";

class Failure extends Error {
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}

const USAGE = "Usage: node scripts/backfill-export.mjs --export <zip> --backup <dir> [--origin <https origin>] [--write] [--hosts-json <path>] [--version]";

function parseArgs(argv) {
  const options = { write: false };
  const valued = { "--export": "export", "--backup": "backup", "--origin": "origin", "--hosts-json": "hostsJson" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--write") options.write = true;
    else if (arg === "--help") options.help = true;
    else if (arg in valued) {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) throw new Failure(`${arg} needs a value\n${USAGE}`, 2);
      options[valued[arg]] = value;
    } else throw new Failure(`unknown argument ${arg}\n${USAGE}`, 2);
  }
  return options;
}

/** The inflated entries `posts.csv` and `posts/<id>.<slug>.html`, and nothing else. */
function readExport(file, backfill) {
  let bytes;
  try {
    bytes = readFileSync(file);
  } catch {
    throw new Failure(`cannot read the export file ${file}`);
  }
  const entryFilter = backfill.createEntryFilter();
  let entries;
  try {
    entries = unzipSync(new Uint8Array(bytes), { filter: entryFilter.filter });
  } catch {
    throw new Failure("the export is not a readable zip file");
  }
  if (entryFilter.problems.length > 0) throw new Failure(`the export is refused: ${entryFilter.problems.join("; ")}`);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const decode = (name) => {
    const data = entries[name];
    // The sizes in the zip's directory are only claims; check what was really inflated.
    if (data.length > backfill.MAX_ENTRY_BYTES) throw new Failure("the export is refused: an entry inflated beyond the size limit");
    try {
      return decoder.decode(data);
    } catch {
      throw new Failure(`an entry of the export is not valid UTF-8 (${name === "posts.csv" ? name : `post ${backfill.classifyEntry(name)?.id}`})`);
    }
  };
  if (!("posts.csv" in entries)) throw new Failure("the export has no posts.csv");
  const htmlById = new Map();
  for (const name of Object.keys(entries)) {
    const entry = backfill.classifyEntry(name);
    if (entry?.kind === "post-html") htmlById.set(entry.id, { slug: entry.slug, html: decode(name) });
  }
  return { csv: decode("posts.csv"), htmlById, unsafeIds: entryFilter.unsafeIds };
}

function resolveOrigin(options, env, scraper) {
  if (options.origin !== undefined) {
    let url;
    try {
      url = new URL(options.origin);
    } catch {
      throw new Failure("--origin is not an address", 2);
    }
    if (url.protocol !== "https:") throw new Failure("--origin must be an https address", 2);
    return url.origin;
  }
  const config = scraper.config.loadConfig(env, readIfExists);
  const url = new URL(config.feedUrl);
  if (url.protocol !== "https:") throw new Failure("the configured feedUrl is not https; give --origin");
  return url.origin;
}

export async function main(argv, env = process.env, out = (line) => console.log(line)) {
  if (argv.includes("--version")) {
    out(`substacker-backfill-export ${packageVersion()}`);
    return 0;
  }
  const options = parseArgs(argv);
  if (options.help) {
    out(USAGE);
    return 0;
  }
  if (!options.export || !options.backup) throw new Failure(`--export and --backup are required\n${USAGE}`, 2);

  const backfill = await scraperModule("backfill");
  const config = { loadConfig: (await scraperModule("config")).loadConfig };
  const origin = resolveOrigin(options, env, { config });

  const { csv, htmlById, unsafeIds } = readExport(options.export, backfill);
  let rows;
  try {
    rows = backfill.parsePostsCsv(csv);
  } catch (e) {
    throw new Failure(`posts.csv is malformed: ${e.message}`);
  }

  const rawDir = resolve(options.backup, "raw");
  const existing = new Set(existsSync(rawDir) ? readdirSync(rawDir).filter((f) => f.endsWith(".xml")).map((f) => f.slice(0, -4)) : []);
  const selection = backfill.selectRows(rows, htmlById, unsafeIds, existing);

  const items = [];
  const skipped = [...selection.skipped];
  for (const candidate of selection.add) {
    try {
      items.push({ slug: candidate.slug, date: candidate.date, text: backfill.buildBackfillItem(candidate, origin) });
    } catch (e) {
      if (!(e instanceof backfill.BackfillError)) throw e;
      skipped.push({ id: candidate.id, slug: candidate.slug, reason: "invalid-item" });
    }
  }
  const hosts = backfill.sortedHosts(backfill.countImageHosts(selection.add.filter((c) => items.some((i) => i.slug === c.slug)).map((c) => c.html)));

  out(`${options.write ? "WRITE" : "DRY RUN"}: ${rows.length} post(s) in posts.csv, origin ${origin}`);
  out(`to add: ${items.length}`);
  for (const item of items) out(`  add ${item.slug} (${item.date.slice(0, 10)})`);
  const byReason = new Map();
  for (const s of skipped) byReason.set(s.reason, [...(byReason.get(s.reason) ?? []), s]);
  out(`skipped: ${skipped.length}`);
  for (const [reason, list] of byReason) {
    out(`  ${reason}: ${list.length}`);
    for (const s of list) out(`    ${s.slug ?? `post ${s.id}`}${s.slug === undefined ? "" : ` (post ${s.id})`}`);
  }
  out(`image hosts (addresses in the bodies to add):`);
  for (const [host, count] of hosts) out(`  ${String(count).padStart(6)}  ${host}`);

  if (options.hostsJson) {
    writeFileSync(options.hostsJson, `${JSON.stringify(Object.fromEntries(hosts), null, 2)}\n`);
    out(`host counts written to ${options.hostsJson}`);
  }
  if (!options.write) {
    out("dry run: nothing written. Add --write to write the files.");
    return 0;
  }

  mkdirSync(rawDir, { recursive: true });
  let written = 0;
  const refused = [];
  for (const item of items) {
    const file = join(rawDir, `${item.slug}.xml`);
    if (dirname(resolve(file)) !== rawDir) {
      refused.push(item.slug);
      continue;
    }
    try {
      // "wx": fails if the file exists, so an existing item is never overwritten.
      writeFileSync(file, item.text, { flag: "wx" });
      written++;
    } catch {
      refused.push(item.slug);
    }
  }
  out(`${written} raw item(s) written to ${rawDir}`);
  if (refused.length > 0) throw new Failure(`refused to write ${refused.length} item(s): ${refused.join(", ")}`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(e instanceof Failure ? e.message : `${e?.name ?? "Error"}: ${e?.message ?? e}`);
      process.exit(e instanceof Failure ? e.code : 1);
    },
  );
}
