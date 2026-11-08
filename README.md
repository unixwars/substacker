# substacker

Back up a Substack publication as static files, and read, search and browse it offline.

**Status: design phase, no code yet.** The design and the implementation plan are in [docs/](docs/).

## What it will be

- **A backup.** A scheduled job reads the publication's RSS feed and commits each post's raw feed item and its images to a protected `content` branch of this repository. The raw items are the backup; every other file is derived from them and can be rebuilt.
- **A static PWA reader.** Browse and search the posts, with previous and next, in your own theme, and read posts you have opened offline. No backend: it is served from GitHub Pages.
- **A small core library.** The content format, search, sanitizing and headless React hooks, so another app can embed the reader and style it itself.

Out of scope: comments, likes and restacks (the reader links to the post on Substack for those), paywalled content beyond the preview the feed carries.

## Layout (planned)

| Path | What it is |
|---|---|
| `packages/core` | The content contract and the pure logic. |
| `packages/scraper` | Reads the feed and writes the content files (`substacker-scrape`). |
| `apps/shell` | The static PWA reader with its own service worker. |
| `apps/relay` | A Cloudflare Worker that relays the feed fetch, only if GitHub's runners are blocked by Substack. |
| `content` branch | The generated files. Orphan branch, no force pushes. |

## Using it for your own publication

Fork the repository, then follow [docs/setup.md](docs/setup.md). In short: **reset the `content` branch** (it holds the original author's posts, not yours), set the `SUBSTACKER_CONFIG` repository variable to your feed's settings, enable Actions and Pages, and the workflow does the rest.

Settings are never committed: copy [substacker.config.example.json](substacker.config.example.json) to `substacker.config.local.json` (gitignored) for local runs, and use the repository variable in CI.

## License

MIT, see [LICENSE](LICENSE).
