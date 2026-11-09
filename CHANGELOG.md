# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

**Before 1.0.0, minor versions may contain breaking changes** (to the content contract, the `substacker-core` API, the configuration and the scripts). Patch versions only fix bugs. Pin the exact version you install and read this file before you upgrade. The release process is in [docs/releasing.md](docs/releasing.md).

## [Unreleased]

### Added

- **`noindex` setting** (default `true`): the reader's page carries `<meta name="robots" content="noindex">` so search engines do not index this second public copy of the posts; `false` leaves the tag out. The tag was already present in the shell's HTML; it is now driven by the configuration, tested, and documented, including what it cannot cover on GitHub Pages (JSON and image files).
- **Backfill from a Substack data export** (`npm run backfill`, `scripts/backfill-export.mjs`): a one-off tool that writes the older posts of an export (a zip) as `raw/<slug>.xml` items into a backup, so the daily scrape downloads their images and the build derives them unchanged. Dry run by default; `--write` never overwrites or deletes. It reads only `posts.csv` and `posts/<id>.<slug>.html`, refuses every other entry (subscriber lists, per-recipient data) before decompressing it, and imports only published, public newsletter posts. The items are synthesized (marked `<substacker:source>export</substacker:source>`), not received from the feed. It also reports the image hosts the old posts use. New dev dependency: `fflate`. See [docs/setup.md](docs/setup.md#backfilling-from-a-substack-export).

### Changed

- The relay is documented as not suitable on Cloudflare: Substack answers the Cloudflare Workers network with HTTP 429. The code stays as a host-agnostic handler.
- The README has the project artwork; the artwork and the icon sources live in `docs/assets/`.

### Removed

- The temporary reachability probe (`probes/`, `probe.yml`).

## [0.1.0] - 2026-11-09

The first official release. One version number, `0.1.0`, covers the whole repository.

### Added

- **Content contract** (version 1): the raw feed item of every post is the backup, and the served files (`index.json`, `search.json`, `posts/<slug>.json` and `images/`) are derived from it. A reader accepts every contract version up to its own and refuses a newer one. `CONTRACT_VERSION` versions the format; the new `VERSION` constant versions the release, and the two are independent.
- **`substacker-core`**, a small embeddable library published as a tarball attached to the GitHub Release: the contract schemas, the HTML sanitizer and its policy (`substacker-core/dom`), post helpers (neighbours, canonical and outbound links, dock links, asset resolution, image type sniffing), full-text search and cache eviction order, and React hooks (`substacker-core/react`). It exports `VERSION`.
- **Scraper and build** (`substacker-scrape`, `substacker-build`): reads the publication's RSS feed, stores each raw item and its images, never deletes, and derives every served file from the backup on each run. Both answer `--version`.
- **Offline PWA shell**: a static reader with a list, a post view, search, an install manifest and a service worker that makes opened posts available offline. The page carries `<meta name="generator" content="substacker 0.1.0">`.
- **Cloudflare relay** (`apps/relay`): a small Worker that fetches the feed for callers that hold a shared secret, only from one allowed host. It is optional, deployed separately and not used by the default setup.
- **Publish workflow** with two scrape modes: `local` (the default; a machine you control scrapes and pushes the backup to the protected `content` branch with `npm run scrape:local`, GitHub Actions builds and deploys) and `ci` (the workflow scrapes and commits). Includes a dry run (`npm run publish:dry-run`).
- **Self-contained scraper container** (`deploy/Dockerfile`): scrapes once a day on a schedule with a random delay, retries failures, pushes to `content`, asks for the deploy, and has a health check. The image holds code only and carries the labels `org.opencontainers.image.version`, `.title` and `.source`. The scheduler logs `substacker <version> started`.
- **Release process**: a `v*` tag runs `.github/workflows/release.yml`, which checks that the tag equals the package version, runs the tests, packs `substacker-core` and creates the GitHub Release with the tarball and the notes taken from this file (`scripts/changelog-section.mjs`). See [docs/releasing.md](docs/releasing.md).

### Security

- **Polite image downloads**: at most 4 requests in flight and 2 per host, a short jittered pause between requests to one host, bounded retries on `429` and `503` that honour `Retry-After`, and no more requests to a host that keeps answering `429`.
- **SSRF-safe downloads**: only `https` addresses, every address checked, redirects checked too, the connection pinned to the address that was checked (no DNS rebinding), a cap on size and redirects, and private, loopback and link-local addresses refused (also in numeric and IPv4-mapped forms).
- **SVG sanitising**: SVG images are sanitized before they are stored (scripts, event handlers, external references and foreign content removed).
- **HTML sanitising**: post HTML is sanitized with a fixed allow-list policy before it is served or rendered.
- The container runs as a non-root user and contains no configuration, token, `.git`, tests or development dependencies; CI checks this on every change.

[Unreleased]: https://github.com/unixwars/substacker/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/unixwars/substacker/releases/tag/v0.1.0
