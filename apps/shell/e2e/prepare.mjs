// Builds the shell with a relative base and assembles one static site per scenario
// under apps/shell/.e2e/site/<name>/ from the fixture feed. Needs `npm run build` at
// the repository root first (it uses the built scraper).
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scenarios } from "./scenarios.mjs";

const shellDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = join(shellDir, "..", "..");
const e2e = join(shellDir, ".e2e");
const scraperDist = join(root, "packages", "scraper", "dist");
if (!existsSync(join(scraperDist, "build.js"))) {
  console.error("Build the workspace first: npm run build");
  process.exit(1);
}
const { build } = await import(join(scraperDist, "build.js"));
const { parseFeed } = await import(join(scraperDist, "feed.js"));
const { imageUrls } = await import(join(scraperDist, "derive.js"));
const { imageName } = await import("substacker-core");

rmSync(e2e, { recursive: true, force: true });
execFileSync("npx", ["vite", "build", "--outDir", join(e2e, "dist"), "--emptyOutDir"], {
  cwd: shellDir,
  stdio: "inherit",
  env: { ...process.env, SUBSTACKER_BASE: "./" },
});

// A 1x1 PNG stands in for every image.
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64");
const feed = readFileSync(join(root, "packages", "scraper", "test", "fixtures", "feed.xml"), "utf8");
const backup = join(e2e, "backup");
mkdirSync(join(backup, "raw"), { recursive: true });
mkdirSync(join(backup, "images"), { recursive: true });
for (const { slug, raw } of parseFeed(feed)) {
  writeFileSync(join(backup, "raw", `${slug}.xml`), raw);
  for (const url of imageUrls(raw)) writeFileSync(join(backup, "images", imageName(url)), png);
}
const emptyBackup = join(e2e, "backup-empty");
mkdirSync(emptyBackup, { recursive: true });

for (const [name, s] of Object.entries(scenarios)) {
  const site = join(e2e, "site", name);
  cpSync(join(e2e, "dist"), site, { recursive: true });
  const config = { feedUrl: "https://example.substack.com/feed", feedName: s.shell.feedName, actions: s.shell.actions, utmSource: s.shell.utmSource, hidden: s.hidden };
  const { files } = build(config, s.noPosts ? emptyBackup : backup);
  for (const [path, data] of files) {
    const file = join(site, "content", path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, data);
  }
  writeFileSync(join(site, "config.json"), JSON.stringify({ contentUrl: "content/", ...s.shell }, null, 2));
}
console.log(`e2e sites ready in ${join(e2e, "site")}`);
