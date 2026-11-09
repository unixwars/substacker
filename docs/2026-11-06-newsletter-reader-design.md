# substacker: a static backup and offline reader for a Substack

Date: 2026-11-06 (revised 2026-11-08). Status: **approved; implemented through plan task 14 (core, scraper, build, shell with offline reading, relay, publish workflow and its dry run, docs), then hardened after a review (bounded and polite downloads, SVG sanitizing, service-worker fixes). The live checks of task 15 are still to be run.**

## Why

A Substack publication's posts live on Substack. We want a copy we own, readable, searchable and browsable offline, and a core that other apps can embed and style themselves. The project is self-contained so that it can be built, validated, released and forked on its own.

## Constraints

- Free tiers only. No backend beyond static hosting and the hosts' own scheduled jobs.
- The feed is `https://<publication>.substack.com/feed`, set in configuration. It carries only the latest 20 items, so everything older comes from the one-off backfill. No publication is named in the repository: the real values live in a GitHub repository variable in CI and in `substacker.config.local.json` (gitignored) locally; `substacker.config.example.json` is the committed template (section 2, Configuration). A mistyped publication name can redirect to an unrelated site, which is why the scraper aborts on a cross-host redirect.
- Substack blocks GitHub's IP range. **Probe result:** the development machine reaches the feed (HTTP 200), but GitHub-hosted runners get HTTP 403 from the feed whatever user agent they send, so the relay was built; it did not help (below). Through the relay the feed answered HTTP 429, so neither route works from CI today; by default the scrape runs on a machine the owner controls (see Decisions settled). The relay stays as an option.
- A publication on a custom domain redirects off `*.substack.com`. `feedUrl` and the relay's `ALLOWED_HOST` must then name the custom host, or the scrape aborts as a cross-host redirect.
- The feed link is configuration, never code: anyone can fork the project and point it at their own feed.
- CI builds and validates everything; logic is unit-tested, flows integration-tested.

## Out of scope

Comments inside the reader (links to the post's comments on Substack are in scope, section 4), liking or restacking from our page (logged-in Substack API calls with no public link; not offered), paywalled content beyond the preview the feed carries, posting back to Substack, subscriber lists, a hosted multi-feed service, converting posts to Markdown, an "open in the Substack app" action (it needs the post's numeric id, which the feed lacks; revisit if the probe finds a reliable source), the one-off backfill of older posts (a script run once by hand, a follow-up issue).

## Design

One repository, `substacker` (public, a monorepo with npm workspaces), with two kinds of branch.

**`main`** holds the code and the configuration template, `substacker.config.example.json`:

| Path | What it is |
|---|---|
| `packages/core` | The contract and the pure logic, used by everything else. Subpaths: `.` (no DOM, no React), `./dom` (the render-time sanitizer), `./react` (headless hooks). The only package that is distributed. |
| `packages/scraper` | Reads a feed and writes the content files. A CLI, `substacker-scrape`, run from the checkout. |
| `apps/shell` | A static PWA reader (Vite and React) with its own service worker: the offline product. |
| `apps/relay` | A Cloudflare Worker that only relays the feed fetch. Built, and deployed only by a fork whose runners are refused by Substack. |

**`content`** is an orphan branch holding only the generated files (section 1). Daily commits land there, so the history of `main` is never buried. It is the only copy of posts older than the feed window, so it is protected: a repository ruleset blocks force pushes and deletion, and nothing in the project rewrites its history.

One workflow (`publish.yml`) runs on a daily schedule, on demand and on a push to `main`. It has a `concurrency` group (`publish`, never cancelling a run in progress) so two runs cannot race to commit, and `permissions` for `contents: write`, `pages: write` and `id-token: write`. It creates the orphan `content` branch if it is missing (a fork gets only the default branch), checks out both branches, runs the scraper only in `ci` mode (idempotent, so a run with nothing new changes nothing) and commits any new backup files to `content`; in `local` mode, the default, it does neither and instead fails with the way out if `content` holds no posts. It then derives the served files from them (section 1), builds the shell and deploys **one Pages site**: the shell at the root and the served content under `/content/`. Deploying in the same workflow matters: a push made with the workflow token triggers no other workflow. The mode is the repository variable `SUBSTACKER_SCRAPE` (`local` or `ci`); in `local` mode a machine the owner controls runs `scripts/scrape-local.mjs`, which pushes the backup to `content` and then asks GitHub to run this workflow through `workflow_dispatch` (a push to `content` cannot start it: workflow files are read from the pushed branch and `content` holds only data). The daily schedule remains the fallback. The shell therefore reads its content from its own origin, with no CORS. It also reports the size of the site and fails above 800 MB (Pages allows about 1 GB). A fork resets the `content` branch if it was copied (it holds the original author's posts; see `docs/setup.md`), sets the repository variable `SUBSTACKER_CONFIG` (the JSON of its configuration, shaped like the example file) to point at another feed, enables Actions (they start disabled on a fork) and Pages, and its own workflow does the rest. Whether a scheduled workflow stays enabled when the only activity is the bot's own pushes (GitHub disables schedules after 60 days without repository activity) is verified in the checklist, and the guide says what to do if it lapses.

Distribution: on a release tag, CI runs `npm pack` for `substacker-core` and attaches the tarball to a GitHub Release. An embedding app depends on it by that URL, and its lockfile pins the integrity hash. No registry account or token is needed. (npm cannot install a subdirectory of a git repository, and a root-level git dependency would build on every install; a registry release was weighed and not chosen.) Contract policy: a reader accepts every contract `version` up to its own and refuses a newer one with a clear message; the scraper rebuilds every derived file on each run, so after a contract change one scraper run fixes the content, and an embedding app bumps its dependency when it wants the new contract.

### 1. The content contract (`packages/core`)

Zod schemas, versioned. There are two layers, and only the first is committed:

- **Backup, on the `content` branch.** `raw/<slug>.xml` is the feed item exactly as received (rewritten only when Substack's copy changes; git keeps the history). `images/<name>` holds the downloaded images, named `<key>.<ext>`: `imageKey(url)` is a hash of the image's address, and the extension is the one the scraper found by sniffing the downloaded bytes (the response's Content-Type is the fallback; an image that neither identifies counts as a failed download, retried next run, and is never stored as `.bin`). The build maps key to file name by listing the directory, so it finds the local copy without reading any file.
- **Served, derived on every deploy and published under `/content/` on the Pages site, never committed.** These are the files readers fetch:

| File | Holds |
|---|---|
| `posts/<slug>.json` | `slug`, `title`, `date`, `excerpt`, `cover`, `html` (sanitized), `sourceUrl`, `contentHash` (of the raw item), `unlocalized` (images still pointing at Substack) |
| `index.json` | `version`, feed `title`, and `posts[]` newest first: `slug`, `title`, `date`, `excerpt`, `cover`. Hidden posts left out. |
| `search.json` | plain `{slug, title, text}` for each visible post |
| `images/<name>` | the backup images, copied alongside |

**A reader, in the shell or in any embedding app, only ever fetches the served files from the Pages address; it never reads `raw/` or builds anything.** The served files stay at stable addresses and keep updating on every deploy, so a third-party app needs no change to its own code to show new posts, as long as the contract `version` it supports is not older than the content's. Keeping the raw item means a new sanitizer policy, a new contract or another output format is a rebuild on the next deploy, not a re-scrape, and the backup cannot be damaged by a bug in the derivation. The key of a post is the `<slug>` of its `/p/<slug>` link, not its title, so renaming a post on Substack does not create a second one and the `hidden` list stays valid. `sourceUrl` is that link without its query. Paths to images and `cover` are relative to the served content root; core's `resolveAssets(html, base)` makes them absolute at render time, in every reader. The index and the search file are built from the stored raw items, not from the latest feed, so what readers show never depends on what the feed carries today. The scraper never deletes.

### 2. The scraper and the build (`packages/scraper`)

Two commands in one package: `substacker-scrape` (fetch the feed and store the backup) and `substacker-build` (derive the served files from the backup). Plain TypeScript, a thin shell over pure functions with fixture-based tests (the first fixture is a hand-made feed item with placeholder text and `example.substack.com` addresses, reproducing the real markup structure: CTA buttons, `<picture>`, `<svg>`, a captioned figure). It reads its configuration (below): `feedUrl`, `feedName`, optional `relayUrl`, `subscribeUrl`, `actions`, `utmSource`, and `hidden`.

- **Configuration.** One JSON document, validated by Zod, resolved in this order: the environment variable `SUBSTACKER_CONFIG` (the workflow fills it from the repository variable of the same name, which is not secret), else `substacker.config.local.json` in the working directory. If neither exists the command fails and points to `substacker.config.example.json`. The relay secret is a separate Actions secret, never part of this document. Since the configuration is not in the repository, `main` carries no publication name, and the real values stay with whoever runs the project.
- **Hiding posts.** `hidden` is a list of slugs. Every post is still stored, but a hidden one is left out of `index.json` and `search.json`, so no reader lists, searches or links to it, and previous and next skip it. A reader asked for a slug that is not in the index says it was not found. Removing a slug from the list brings the post back on the next run without re-fetching it, and the list survives edits on Substack. It applies to every surface at once. Hiding is a display choice, not confidentiality: the files are in a public branch and the post is public on Substack. A slug that matches no stored post is a warning.
- **Idempotent.** The raw item is rewritten only when its hash changes, and an image is downloaded only if its file is missing. Nothing derived is committed, so the `content` branch changes only when there is something new to back up, and a run with nothing new commits nothing. The build is a pure function of the backup and the configuration, run on every deploy.
- **Failure.** A feed fetch or parse error aborts the scrape with no partial commit; a malformed feed never overwrites good content. A redirect to another host aborts it too (the old feed URL redirects to a stranger's site). An image that fails to download does not fail the run: the next scrape retries every stored item whose image file is missing, and until then the built post keeps that image's original address and is marked `unlocalized`. A build error fails the deploy and leaves the previous site live; the backup is untouched, so fixing the build and re-running recovers.
- **Images.** Body images come from several hosts (Substack's CDN, its S3 bucket, third parties such as Unsplash), so they are fetched directly and are not subject to the relay. Each `<picture>` keeps one candidate and becomes a plain `<img>`; the other widths are dropped to save space. The scraper downloads them politely and safely: https only, every redirect hop and resolved address checked (no loopback, private or link-local target), a 30 s timeout and a streaming size cap, at most 4 requests in flight and 2 per host with a short pause between requests to one host, `429`/`503` retried a bounded number of times honouring `Retry-After`, and a host that keeps answering 429 is left alone for the rest of the run. An SVG is kept but sanitized before it is stored (no script, handlers, `foreignObject` or external references). `docs/setup.md` has the details. An item the build cannot derive (no valid date, say) is skipped with a warning, never stored by the scrape and never fatal to the build.
- **Publishing.** The workflow commits the new backup files with plain `git` to the `content` branch, then builds and deploys. No review step.
- **Reaching Substack.** If the runner's IPs are blocked from the feed, the job fetches the feed through the relay: a Worker that fetches one URL, allowlisted to the feed host, for callers with a secret. It parses and commits nothing, which keeps it inside the free Worker limits.
- **Probe first.** A script in `probes/`, committed with its task, fetches the feed and one image of each kind from GitHub Actions and through the relay, and checks whether `/api/v1/posts/<slug>` returns a numeric id. Its result decides whether the relay is built and whether the app action can be revisited. A GitLab arm is added only if both fail.

### 3. Sanitizing

The raw item is stored verbatim, because it is the backup. Posts are sanitized when the served files are built (`substacker-build`) and again when rendered: a compromised `content` branch would otherwise be an XSS path into whichever origin shows it. One library, DOMPurify, runs on both sides (in Node through jsdom for the scraper), configured from one policy that is **data in core** (allowed tags, attributes and URL schemes). A test runs a corpus of hostile inputs (scripts, handlers, `javascript:` links, iframes, SVG) and asserts properties of the output, not exact strings.

Substack's own widgets are handled before sanitizing, from the feed's real markup: `<p class="button-wrapper"><a class="button primary">` blocks are recognized by `href` (subscribe, comments, share) and removed from the body, because the readers offer those actions themselves (section 4); any other such link stays as a plain link. `<button>`, `<svg>`, `data-attrs` and the `class` attributes are dropped. An iframe or embed becomes a link to its source.

### 4. Reader surfaces

Both are built on `core/react` hooks (`useFeedIndex`, `useSearch`, `usePost`), which take the content base URL and a `fetch`. They own loading, errors and the version guard, and render nothing: markup and styling belong to the host, so the shell and any embedding app each look like themselves. Search is built in the browser with MiniSearch from `search.json`, on first use.

- **Actions.** `actions` is a subset of `comment` and `share`, empty by default, so a deployment decides after seeing how it feels. `comment` links to `<sourceUrl>/comments` and `share` to `<sourceUrl>?action=share`, both in a new tab. Every outbound link to Substack carries our own `utm_source` (`utmSource`, default `substacker`) and `utm_medium=reader`, so the author's Substack statistics show the reader as a source; the feed's own `utm_` values, which would label our readers as email, are not kept. A post always ends with a "read on Substack" link, which also covers a paid post whose feed body is only the preview. Subscribe is a link to `subscribeUrl`, hidden when unset.
- **The shell (`apps/shell`).** A static PWA: list with search and an empty state, post with previous and next. Configured by a `config.json` it loads at start (`contentUrl`, `feedName`, `subscribeUrl`, `actions`, `utmSource`), written at build time from the resolved configuration. Routes are hash-based, so it works on any static host under any path; the Vite base comes from the environment. Styled with CSS variables for the theme.
- **Offline, in the shell's own service worker.** The precache list is generated at build time (a hand-written file cannot know Vite's hashed names). `index.json` and `search.json` are stale-while-revalidate; posts and images are cached when opened. A cap (default 50 MB, configurable so a test can lower it) evicts the least recently opened post first. The Cache API stores no access times, so the shell records them in IndexedDB; the eviction order is a pure function in core. A marker shows which posts are available offline. Project Pages sites share an origin with all of their owner's other sites, so cache names and IndexedDB keys carry a prefix from the base path, and cleanup touches only that prefix.
- **Embedding.** The core is built to be embedded: `core/react` plus the sanitizer, `resolveAssets`, `neighbours` and `dockLinks` are all a host app needs. The host brings its own markup, styling and user-facing strings (the core ships none), fetches the content cross-origin (Pages sends an open CORS header), and should mark its pages `noindex`, since a second public copy of the posts is duplicate content. A host with a Content-Security-Policy needs the content origin in `connect-src` and `img-src`. Online-only embedding is fine; offline reading is the shell's job.

## Testing

- Core: every pure function, schemas against good and malformed payloads (including a newer `version`), the sanitizer corpus, `resolveAssets`, the link builders, the hooks with a fake `fetch`.
- Scraper: the structural fixture item; idempotence (a second run commits nothing); a rebuild from raw after a policy change; the failure paths (no partial commit; a cross-host redirect aborts; an image failure still publishes and is retried); hiding and unhiding.
- Shell: Playwright against a local fixture content directory, including offline (the context goes offline after one visit and a cached post still opens, an uncached one says so).
- Gates: type check, lint, tests, and an install check that packs `substacker-core` and imports it from an empty project.

## Needs a real service or a person (checklist at PR time)

Running the probe; creating the repository, the `content` branch and its ruleset, and enabling Pages from Actions; deploying the relay with its secret, if needed; one live `scrape:local` run with a real push and dispatch, a systemd timer run, a scheduled workflow run and a second the next day; that the scheduled workflow stays enabled; the one-off backfill; installing the shell on a phone and reading a post offline; installing the released `substacker-core` tarball in an empty project and rendering a post with the hooks; checking the CORS header Pages serves; checking that the comments and share links land where they should on Substack and that the author's statistics show the new source.

## Decisions settled in the design discussion

- A separate project, with the reader's logic in a core that other apps import; the shell is the offline product.
- One repository, content on an orphan branch, protected; the raw feed item is the backup and everything else is derived.
- ~~The scraper does its work in CI in the same repository; the Cloudflare Worker is at most a feed relay.~~ Superseded 2026-11-08 by the next item. Vercel cron was rejected because it couples the scraper to an app.
- **The scrape runs on a machine the owner controls by default.** The probe found the feed refuses GitHub's runners (403) and the Cloudflare relay (429). `scripts/scrape-local.mjs` (`npm run scrape:local`) scrapes into a worktree of `content`, commits `raw/` and `images/` if changed, pushes without force and then dispatches `publish.yml` through the REST API with an optional fine-grained token; a failed dispatch is a warning, and the daily schedule is the fallback. `SUBSTACKER_SCRAPE` (`local`, the default, or `ci`) selects whether the workflow also scrapes; the scrape-in-CI path and the relay stay and keep working. No workflow file goes on `content`.
- Publishing: direct commits, no PR. Distribution: release-asset tarball of `substacker-core`.
- Search is built in the browser with MiniSearch; no `articleJsonLd`, no reading time, no Markdown conversion; DOMPurify only.
- The served files are derived at build time and not committed; consumers only fetch them from Pages.
- A `hidden` list turns posts off in every reader while the backup keeps them.
- The feed link is configuration; forks are a supported use. Outbound links carry our own `utm_` source, not the feed's.
- Simpler backup-only alternatives (a bare git-scraping job, the Wayback Machine) were considered and not taken.

## Open before the plan is executed

- Whether Substack accepts the relay's Cloudflare network (the probe settled that GitHub's runners are refused), and whether a numeric post id is obtainable.
- The repository is assumed public: the posts already are, and free Pages hosting requires it.
