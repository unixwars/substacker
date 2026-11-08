// Assembles one static site per scenario under apps/shell/.e2e/site/<name>/ from the
// fixture feed, with the same code the publish workflow uses (scripts/site.mjs): the
// shell with its config.json at the root, the served content under content/. Needs
// `npm run build` at the repository root first (it uses the built scraper).
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { imageKey } from "substacker-core";
import { buildShell, root, scraperModule, shellConfigFor, shellDir, writeFiles } from "../../../scripts/site.mjs";
import { scenarios } from "./scenarios.mjs";

const e2e = join(shellDir, ".e2e");
const { build } = await scraperModule("build");
const { parseFeed } = await scraperModule("feed");
const { imageUrls } = await scraperModule("derive");

rmSync(e2e, { recursive: true, force: true });

// A 1x1 PNG stands in for every image.
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64");
const feed = readFileSync(join(root, "packages", "scraper", "test", "fixtures", "feed.xml"), "utf8");
const backup = join(e2e, "backup");
mkdirSync(join(backup, "raw"), { recursive: true });
mkdirSync(join(backup, "images"), { recursive: true });
for (const { slug, raw } of parseFeed(feed)) {
  writeFileSync(join(backup, "raw", `${slug}.xml`), raw);
  for (const url of imageUrls(raw)) writeFileSync(join(backup, "images", `${imageKey(url)}.png`), png);
}
const emptyBackup = join(e2e, "backup-empty");
mkdirSync(emptyBackup, { recursive: true });

for (const [name, s] of Object.entries(scenarios)) {
  const site = join(e2e, "site", name);
  const config = { feedUrl: "https://example.substack.com/feed", feedName: s.shell.feedName, actions: s.shell.actions, utmSource: s.shell.utmSource, hidden: s.hidden };
  // The shell is built per scenario: the manifest takes its name from this config.json.
  await buildShell({ outDir: site, shellConfig: shellConfigFor(config, s.shell), scratchDir: join(e2e, "config", name) });
  writeFiles(join(site, "content"), build(config, s.noPosts ? emptyBackup : backup).files);
}
console.log(`e2e sites ready in ${join(e2e, "site")}`);
