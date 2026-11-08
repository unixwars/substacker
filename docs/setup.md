# Setup and forking

Status: the commands and file names below exist; the live steps (Pages, the ruleset, the relay, a scheduled run) have not been run against a real repository yet.

## 1. Fork and reset the `content` branch

The `content` branch holds the generated backup of **the original author's** publication. A fork of this repository, or a copy made from a clone, may carry it over. Reset it before the first run, or your site would serve someone else's posts alongside yours.

If your fork has no `content` branch, skip this step: the workflow creates an empty one.

```bash
git checkout --orphan content-reset
git rm -rf .
git commit --allow-empty -m "Reset content branch"
git push --force origin content-reset:content
git checkout main && git branch -D content-reset
```

The force push is deliberate and only for this one-time reset, on your own copy. Do it **before** applying the branch protection ruleset (step 4), which blocks force pushes and deletion.

## 2. Configure your publication

Settings are not stored in the repository, so no publication is named in the code. The template is `substacker.config.example.json`:

| Key | Meaning |
|---|---|
| `feedUrl` | `https://<publication>.substack.com/feed`. Check it by opening it in a browser; a mistyped name can redirect to an unrelated site, and the scraper aborts on a redirect to another host. |
| `feedName` | Title shown in the reader. |
| `subscribeUrl` | Optional. Shows a Subscribe link. |
| `actions` | Subset of `comment`, `share`. Empty by default. |
| `utmSource` | Label for Substack's statistics. Default `substacker`. |
| `hidden` | Slugs left out of every reader. The backup still keeps them. |
| `relayUrl` | Optional. The address of your deployed relay (step 3a), needed if Substack refuses GitHub's runners. |

**In CI:** Settings, Secrets and variables, Actions, Variables. Create `SUBSTACKER_CONFIG` whose value is your configuration as JSON, shaped like the example. A variable is not secret; anyone with access to the repository settings can read it. If you use the relay, its shared secret goes in an Actions *secret*, never in this variable.

**Locally:** copy the example to `substacker.config.local.json` (gitignored) and edit it. The environment variable `SUBSTACKER_CONFIG`, if set, takes precedence over the file.

## 3. Enable Actions and Pages

- Actions start disabled on a fork: open the Actions tab and enable them.
- Settings, Pages, Source: GitHub Actions.
- Run the `publish` workflow once by hand. After that it runs daily and on every push to `main`.

## 3a. The relay (if Substack refuses GitHub's runners)

Substack may answer HTTP 403 to requests from GitHub's runners. If a run of the `publish` workflow fails with `feed fetch failed: HTTP 403` and no `relayUrl` is set, deploy the relay, a small Cloudflare Worker (`apps/relay`, free tier) that fetches the feed for the scraper. It is not needed if the runners reach the feed directly.

**What it does.** It answers `GET <relayUrl>?url=<feed address>` for callers that send the header `x-relay-secret: <secret>`, compared in constant time with the Worker secret `RELAY_SECRET`. It only fetches `https` addresses on the one host in the Worker variable `ALLOWED_HOST`, refuses any redirect to another host, caps the body at 10 MB and passes the status and body through. Errors it generates itself: 401 (secret missing or wrong), 403 (another host, or a redirect to one), 405 (not GET), 400 (no or bad `url`), 502 (upstream failed, too many redirects, body too large), 500 (relay not configured). It identifies itself with `User-Agent: substacker-relay/<version>`; it does not pretend to be a browser.

**Deploy it**, from a clone, with a free Cloudflare account:

```bash
cd apps/relay
npx wrangler login
npx wrangler deploy --var ALLOWED_HOST:<publication>.substack.com
npx wrangler secret put RELAY_SECRET     # paste a long random value, e.g. from: openssl rand -base64 32
```

`wrangler deploy` prints the Worker's address (`https://substacker-relay.<your-subdomain>.workers.dev`). `wrangler.toml` holds only a placeholder `ALLOWED_HOST` and no account id or secret; pass your own host with `--var` on every deploy, or edit it locally and do not commit it.

**Tell the scraper about it:**

1. Repository, Settings, Secrets and variables, Actions, **Secrets**: create `SUBSTACKER_RELAY_SECRET` with the same value you gave `wrangler secret put`.
2. Add `"relayUrl": "https://substacker-relay.<your-subdomain>.workers.dev"` to the `SUBSTACKER_CONFIG` repository **variable** (the address is not secret).
3. Locally, export `SUBSTACKER_RELAY_SECRET` and put the same `relayUrl` in `substacker.config.local.json`.

When `relayUrl` is set the scraper requires `SUBSTACKER_RELAY_SECRET` and fetches only the feed through the relay; images are fetched directly, since they come from several hosts.

**Unverified:** whether Substack accepts requests that come from Cloudflare's network is not known until you try. After deploying, run the `publish` workflow by hand. If the feed fetch still fails with 403 (now reported without the `relayUrl` hint), the relay does not help from that network and another route is needed.

## 4. Protect the `content` branch

It is the only copy of posts older than the feed window (the feed carries about the latest 20). Add a repository ruleset on `content` that blocks force pushes and deletion. Nothing in the project rewrites its history. A ruleset can only be applied by a repository admin, so this is a manual step.

In the web UI: Settings, Rules, Rulesets, New ruleset, New branch ruleset.

1. Name: `protect-content`. Enforcement status: Active.
2. Target branches: Add target, Include by pattern, `content`.
3. Branch rules: tick **Restrict deletions** and **Block force pushes**. Leave everything else off: the publish workflow pushes to this branch directly with the workflow token, so do not require pull requests or status checks.
4. Bypass list: leave empty.
5. Create.

Or with the GitHub CLI, from a clone of your repository:

```bash
gh api -X POST "repos/{owner}/{repo}/rulesets" --input - <<'JSON'
{
  "name": "protect-content",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["refs/heads/content"], "exclude": [] } },
  "rules": [{ "type": "deletion" }, { "type": "non_fast_forward" }],
  "bypass_actors": []
}
JSON
```

Check it: `git push --force origin <anything>:content` must be rejected.

The same ruleset logic applies to `main` if you like (require the `CI` workflow to pass), but the project does not depend on it.

## Local development

Prerequisites: Node.js 22 or newer and npm. There is no Docker and no database.

```bash
git clone https://github.com/unixwars/substacker.git
cd substacker
npm ci
npm run build
```

To run the scraper locally, create `substacker.config.local.json` (see step 2), check out the `content` branch into `content/` (`git worktree add content content`, or an empty directory for a first run), then run `npx substacker-scrape --backup content` and `npx substacker-build --backup content --out site/content` (both accept `--help`).

## Repository variables and secrets

| Name | Kind | Used by |
|---|---|---|
| `SUBSTACKER_CONFIG` | Actions variable | publish workflow; the configuration JSON (step 2) |
| `SUBSTACKER_RELAY_SECRET` | Actions secret | only if you use `relayUrl`; sent to the relay as the `x-relay-secret` header, and the same value as the Worker's `RELAY_SECRET` |

CI (`.github/workflows/ci.yml`) needs neither: its tests use fixtures and no real feed.

## What the workflow does, and a dry run

`publish.yml` scrapes into the `content` branch, commits the backup only if it changed, builds the shell and the served files into one site, checks its size (fails above 800 MB) and deploys it. To see its steps locally without pushing anything:

```bash
npm run build
npm run publish:dry-run                      # fixture feed served locally; prints what it would commit and deploy
node scripts/publish-dry-run.mjs --workdir /tmp/dry   # run twice: the second run would commit nothing
```

## 5. If the schedule lapses

GitHub disables scheduled workflows after 60 days without repository activity. If the daily run stops, re-enable it in the Actions tab or run it by hand. Behaviour with only the bot's own commits is checked in the plan's final checklist.

## Serving the shell under a path

The shell uses hash routes (`#/p/<slug>`), so any static host can serve it and a reload never needs server rewrites. Vite's base comes from the environment when building:

```bash
SUBSTACKER_BASE=/my-repo/ npm run build -w substacker-shell   # project Pages site
SUBSTACKER_BASE=./        npm run build -w substacker-shell   # relative: works under any path
```

The default is `/`. The shell reads `config.json` from its own folder (`contentUrl`, `feedName`, `subscribeUrl`, `actions`, `utmSource`, and optionally `offlineCapBytes`, default 50 MB), and the publish workflow writes it from the resolved configuration.

Offline reading is handled by a service worker generated at build time (`sw.js`, with the list of files to precache). Project Pages sites share one origin with all of their owner's other sites, so its cache names and its IndexedDB database carry a prefix taken from the base path (`substacker:/my-repo/:`) and cleanup only touches that prefix. The worker handles content under the shell's own path (`index.json`, `search.json` and `config.json` are served stale-while-revalidate; posts and images are stored when opened); a content address on another origin is not cached.

## Icons and the manifest

The icons come from `assets/icon.webp` (full colour) and `assets/icon.svg` (the glyph). `npm run icons -w substacker-shell` regenerates `icon-192.png`, `icon-512.png`, `icon-maskable-512.png` (the icon at 80% on its own background colour, inside the maskable safe zone), `apple-touch-icon.png` and the vector `icon.svg` in `apps/shell/public/`. The PNGs are committed, so a build and CI need no image tooling; run the script only if you replace the sources (it uses the `sharp` devDependency of `apps/shell`).

`manifest.webmanifest` is generated by the shell's Vite build: `name` is the `feedName` of the shell's `config.json` and `short_name` is derived from it. The build reads the file named by `SUBSTACKER_SHELL_CONFIG` (the publish workflow sets it); without it, as in `npm run dev`, the name is the neutral default `Reader`.

## Contract policy

A reader accepts every contract `version` up to its own and refuses a newer one with a clear message. The scraper rebuilds every derived file on each run, so after a contract change one run fixes the content.
