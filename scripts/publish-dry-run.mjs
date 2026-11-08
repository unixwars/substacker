// Runs the publish workflow's steps against the fixture feed (served from a local
// HTTP server, so nothing reaches the network) and reports what the workflow would
// commit to the `content` branch and what it would deploy. Nothing is pushed.
//
//   node scripts/publish-dry-run.mjs [--workdir <dir>] [--feed <file>] [--json]
//
// With --workdir the state persists, so a second run shows that nothing new would be
// committed. Without it a temporary directory is used and removed. Needs
// `npm run build` first (the scraper CLI and the shell build). The steps are the ones in
// scripts/publish.mjs, the same code the workflow runs. --feed serves another feed file
// in place of the fixture.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { commitBackupStep, scrapeStep, siteStep, sizeStep } from "./publish.mjs";
import { SITE_LIMIT_BYTES, dirSize, listFiles, root } from "./site.mjs";

const run = promisify(execFile);
const args = process.argv.slice(2);
const json = args.includes("--json");
const given = args.includes("--workdir") ? resolve(args[args.indexOf("--workdir") + 1] ?? "") : undefined;
const work = given ?? mkdtempSync(join(tmpdir(), "substacker-dry-run-"));
mkdirSync(work, { recursive: true });
const say = (m) => { if (!json) console.log(m); };

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64");
const feedFile = args.includes("--feed") ? resolve(args[args.indexOf("--feed") + 1] ?? "") : join(root, "packages", "scraper", "test", "fixtures", "feed.xml");
const fixture = readFileSync(feedFile, "utf8");

// The fixture feed, with every image host pointed at this server.
let origin = "";
const server = createServer((req, res) => {
  if (req.url === "/feed") {
    const body = ["https://substackcdn.com", "https://images.unsplash.com", "https://substack-post-media.s3.amazonaws.com"].reduce((s, h) => s.replaceAll(h, origin), fixture);
    res.writeHead(200, { "content-type": "application/rss+xml" }).end(body);
  } else {
    res.writeHead(200, { "content-type": "image/png" }).end(PNG);
  }
});
// Image keys hash the image address, so a second run in the same work directory must
// see the same address: the port is remembered there.
const portFile = join(work, "port");
const port = existsSync(portFile) ? Number(readFileSync(portFile, "utf8")) : 0;
await new Promise((resolve, reject) => {
  server.once("error", (e) => reject(new Error(`cannot listen on port ${port} used by the earlier run in ${work}: ${e.message}`)));
  server.listen(port, "127.0.0.1", resolve);
});
writeFileSync(portFile, String(server.address().port));
origin = `http://127.0.0.1:${server.address().port}`;

const config = { feedUrl: `${origin}/feed`, feedName: "Example Newsletter", actions: [], utmSource: "substacker", hidden: [] };
// The fixture server is on loopback, which the scraper refuses unless told (tests and this dry run only).
const env = { ...process.env, SUBSTACKER_CONFIG: JSON.stringify(config), SUBSTACKER_UNSAFE_ALLOW_PRIVATE_NETWORK: "1" };
const backup = join(work, "content");
const site = join(work, "site");
const git = (...a) => run("git", ["-C", backup, "-c", "user.name=github-actions[bot]", "-c", "user.email=41898282+github-actions[bot]@users.noreply.github.com", ...a]);

try {
  // The workflow creates the orphan `content` branch if missing, then checks it out.
  try {
    await git("rev-parse", "--verify", "HEAD");
  } catch {
    mkdirSync(backup, { recursive: true });
    await run("git", ["init", "-q", "-b", "content", backup]);
    await git("commit", "-q", "--allow-empty", "-m", "Create the content branch");
  }

  say("1. scrape into the backup");
  const scrape = await scrapeStep({ backup, env });
  say(`   ${scrape.stdout.trim()}`);

  say("2. files the backup commit would hold");
  const staged = await commitBackupStep({ backup, push: false });
  say(staged.length === 0 ? "   nothing to commit" : staged.map((f) => `   ${f}`).join("\n"));

  say("3. build the shell, then the served content, into one site");
  await siteStep({ backup, out: site, env });

  say("4. site size");
  const size = sizeStep({ out: site });
  if (!size.ok) throw new Error("the site is over the Pages budget");
  say(`   ${size.summary}`);

  const deploy = listFiles(site);
  say(`5. files it would deploy (${deploy.length})`);
  if (!json) for (const f of deploy) console.log(`   ${f}`);
  const report = { commit: staged, deploy, siteBytes: dirSize(site), limitBytes: SITE_LIMIT_BYTES };
  if (json) console.log(JSON.stringify(report));
} finally {
  server.close();
  if (!given) rmSync(work, { recursive: true, force: true });
}
