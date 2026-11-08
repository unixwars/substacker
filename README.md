# substacker

[![CI](https://github.com/unixwars/substacker/actions/workflows/ci.yml/badge.svg)](https://github.com/unixwars/substacker/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Back up a Substack publication as static files, and read, search and browse it offline. A scheduled job reads the publication's RSS feed and commits each post's raw feed item and its images to a protected `content` branch; a static PWA reader and a small embeddable core library are derived from that backup.

**Status: under construction.** The core, scraper, build and the shell (including offline reading) exist and are tested. Not yet built: the publish workflow, the optional relay, the first release, and the live checks listed at the end of the plan. The design and the implementation plan are in [docs/](docs/).

## What it is

- **A backup.** The raw feed items and their images, committed to a protected `content` branch. Every other file is derived from them and can be rebuilt.
- **A static PWA reader.** Browse and search the posts, with previous and next, in your own theme, and read opened posts offline. No backend: it is served from GitHub Pages.
- **A small core library.** The content format, search, sanitizing and headless React hooks, so another app can embed the reader and style it itself.

Out of scope: comments, likes and restacks (the reader links to the post on Substack for those), and paywalled content beyond the preview the feed carries.

## Layout

| Path | What it is |
|---|---|
| `packages/core` | The content contract and the pure logic (`substacker-core`, the only distributed package). |
| `packages/scraper` | Reads the feed and writes the content files (`substacker-scrape`, `substacker-build`). |
| `apps/shell` | The static PWA reader with its own service worker. |
| `apps/relay` | A Cloudflare Worker that relays the feed fetch, only if GitHub's runners are blocked by Substack. Not built yet; it waits on the probe result. |
| `content` branch | The generated backup. Orphan branch, no force pushes. |

## Local build & development

### Prerequisites

- Node.js 22 or newer (CI uses 22)
- npm (ships with Node)

There is no Docker, no database and no other service.

### Installation & build

```bash
git clone https://github.com/unixwars/substacker.git
cd substacker
npm ci
npm run build
```

Other scripts: `npm run typecheck`, `npm run lint`, `npm test` (unit then integration; the end-to-end suite is separate). To try the CLIs, see "Local development" in [docs/setup.md](docs/setup.md).

Settings are never committed: copy [substacker.config.example.json](substacker.config.example.json) to `substacker.config.local.json` (gitignored) for local runs, and use the `SUBSTACKER_CONFIG` repository variable in CI.

## Testing strategy

| Layer | Covers | Command |
|---|---|---|
| Unit | Pure logic in `packages/*` (contract, sanitizing, post logic, search, hooks with a fake `fetch`, feed parsing, derivation). No network, no browser. | `npm run test:unit` |
| Integration | Whole flows against fixture feeds: scrape then build, idempotence, failure paths. Packing `substacker-core`, installing the tarball in an empty directory and importing every subpath (needs the npm registry). | `npm run test:integration` |
| Shell end-to-end | Playwright (Chromium) against static sites assembled from the fixture feed: list, post, previous and next, search, empty state, hidden post, dock and Subscribe by configuration, and offline reading (offline reload, an unopened post, cap eviction, a second shell on the same origin). Needs `npm run build` first and, once, `npx playwright install chromium`. | `npm run test:e2e` |

Unit tests are `*.test.ts` beside the code; integration tests are `*.integration.test.ts` (plus `test/` at the root); end-to-end specs are in `apps/shell/e2e`. Static gates: `npm run typecheck` (strict `tsc`) and `npm run lint` (ESLint).

## Continuous integration

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on every pull request, on pushes to `main` and `dev`, and on demand. Each job installs with `npm ci` on Node 22 with the npm cache:

1. **Typecheck and lint:** `npm run typecheck`, `npm run lint`.
2. **Dependency audit:** `npm audit --omit=dev --audit-level=high`, as its own job so the result is reported separately.
3. **Unit tests:** `npm run test:unit` with V8 coverage and a JUnit report, uploaded as the `unit-reports` artifact.
4. **Integration tests:** `npm run test:integration` with a JUnit report, uploaded as `integration-reports`.
5. **Shell end-to-end:** installs Chromium (`npx playwright install --with-deps chromium`), runs `npm run build` then `npm run test:e2e`, and uploads the Playwright report as `e2e-reports`.

There is no database or container here, so "integration" means: a fixture feed served by a local HTTP server goes through scrape then build (and a second run changes nothing); the failure paths (down feed, cross-host redirect, failed image then retry) and hiding behave as specified; `substacker-core` is packed, installed from the tarball in an empty temporary project (this step reaches the npm registry) and every subpath is imported; and Playwright drives the built shell against fixture content, including offline.

A tag `v*` triggers [`release.yml`](.github/workflows/release.yml), which packs `substacker-core` and attaches the tarball to a GitHub Release.

## Using it for your own publication

Fork the repository, then follow [docs/setup.md](docs/setup.md). In short: **reset the `content` branch** (it may hold the original author's posts, not yours), set the `SUBSTACKER_CONFIG` repository variable to your feed's settings, protect `content` with a ruleset, enable Actions and Pages, and the workflow does the rest.

## More

- [Design spec](docs/2026-11-06-newsletter-reader-design.md)
- [Implementation plan](docs/2026-11-07-newsletter-reader.md)
- [Fork and setup guide](docs/setup.md)

## License

MIT, see [LICENSE](LICENSE).
