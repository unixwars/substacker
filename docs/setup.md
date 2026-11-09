# Setup and forking

Status: the commands and file names below exist; the live steps (Pages, the ruleset, a real push and dispatch, a timer, a scheduled run) have not been run against a real repository yet. The feed refuses GitHub-hosted runners, so by default the scrape runs on a machine you control (section "Two modes", steps 3c and 3d). The container in 3d has not been built by a container engine yet; see its "Not verified" list.

Releases and versions (what a tag does, how to install the core tarball, how to label the container image): [releasing.md](releasing.md).

## Two modes: where the scrape runs

The feed refuses GitHub's runners (HTTP 403 whatever user agent is sent), and the Cloudflare relay did not help (HTTP 429 through it). So the repository variable `SUBSTACKER_SCRAPE` selects where the scrape happens:

| `SUBSTACKER_SCRAPE` | Who scrapes | What the `publish` workflow does |
|---|---|---|
| `local` (the default, also when the variable is unset) | A machine you control runs `npm run scrape:local` (your laptop, or a small server with a timer), or a long-running container does it daily (step 3d), and pushes the backup to the `content` branch. | Skips the scrape and the backup commit, checks that `content` holds posts, builds the shell and the served files from it and deploys. |
| `ci` | The workflow, through the feed directly or through the relay (`relayUrl`, step 3a). | Scrapes, commits the backup, builds and deploys. Use it only if a network of yours reaches the feed from Actions. |

The relay and the scrape-in-CI path stay in the repository and keep working; they are simply not the default. The mode logic is in `scripts/publish.mjs` (the workflow only passes the variable), and `npm run publish:dry-run -- --mode local` or `--mode ci` shows each.

A push to `content` cannot start the workflow by itself: workflow files are read from the pushed branch, and `content` holds only data (never add workflow files to it). So after pushing a new commit, `scrape:local` asks GitHub to run `publish.yml` on `main` through the REST API (`workflow_dispatch`), if it has a token (step 3c). The daily `schedule` in the workflow stays as the fallback: it rebuilds from whatever is on `content`, so a failed or missing dispatch only delays the deploy.

## 1. Fork and reset the `content` branch

The `content` branch holds the generated backup of **the original author's** publication. A fork of this repository, or a copy made from a clone, may carry it over. Reset it before the first run, or your site would serve someone else's posts alongside yours.

If your fork has no `content` branch, skip this step: create it with `npm run scrape:local -- --init` (step 3c), or let the workflow create an empty one.

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
| `feedUrl` | `https://<publication>.substack.com/feed`. Check it by opening it in a browser; a mistyped name can redirect to an unrelated site, and the scraper aborts on a redirect to another host. **Custom domain:** a publication on its own domain redirects off `*.substack.com`, so use the custom host here (and as the relay's `ALLOWED_HOST`), or the scrape aborts as a cross-host redirect. Must be an http(s) address; only https is fetched. |
| `feedName` | Title shown in the reader. |
| `subscribeUrl` | Optional. Shows a Subscribe link. |
| `actions` | Subset of `comment`, `share`. Empty by default. |
| `utmSource` | Label for Substack's statistics. Default `substacker`. |
| `hidden` | Slugs left out of every reader. The backup still keeps them. |
| `relayUrl` | Optional, `ci` mode only. The address of your deployed relay (step 3a). Must be https: the secret travels with every request. |
| `maxConcurrentDownloads` | Optional, 1 to 8, default 4. Image downloads in flight at once (never more than 2 per host). |

**In CI:** Settings, Secrets and variables, Actions, Variables. Create `SUBSTACKER_CONFIG` whose value is your configuration as JSON, shaped like the example (the workflow's build needs `feedName` and the other display settings even in `local` mode). A variable is not secret; anyone with access to the repository settings can read it. If you use the relay, its shared secret goes in an Actions *secret*, never in this variable. Never put a token in this document or in `substacker.config.local.json`.

**Locally:** copy the example to `substacker.config.local.json` (gitignored) and edit it. The environment variable `SUBSTACKER_CONFIG`, if set, takes precedence over the file.

## 3. Enable Actions and Pages

- Actions start disabled on a fork: open the Actions tab and enable them.
- Settings, Pages, Source: GitHub Actions.
- The workflow deploys through the `github-pages` environment, which by default only accepts deployments from `main`; run it from `main`.
- In `local` mode, do step 3c first (the workflow refuses to deploy an empty backup and says so), then run the `publish` workflow once by hand. After that it runs daily, on every push to `main` and whenever `scrape:local` dispatches it.

## 3a. The relay (`ci` mode only; not suitable on Cloudflare)

Substack answers HTTP 403 to requests from GitHub's runners. The relay (`apps/relay`) is a small fetch-and-forward handler, written as a Cloudflare Worker, that fetches the feed for the scraper in `ci` mode.

**It is not suitable on Cloudflare.** Deployed as a Worker on the free tier and tested on 2026-11-09, it was answered with HTTP 429 (Too Many Requests) every time: five attempts over about an hour, from GitHub Actions through the Worker, while the same feed returned 200 to direct requests from an Oracle Cloud instance and from a home machine. The Worker itself was verified working (401 without the secret, 403 for another host); it is Substack that refuses the Cloudflare Workers network. Do not deploy it there. The handler takes and returns standard `Request` and `Response` objects, so it can be ported to another host with a thin adapter (another provider's functions may be accepted; it is untested), but the default `local` mode needs no relay at all. If you deployed it, remove it with `npx wrangler delete` from `apps/relay`.

The rest of this section describes the relay for completeness.

**What it does.** It answers `GET <relayUrl>?url=<feed address>` for callers that send the header `x-relay-secret: <secret>`, compared in constant time with the Worker secret `RELAY_SECRET`. It only fetches `https` addresses on the one host in the Worker variable `ALLOWED_HOST`, refuses any redirect to another host, caps the body at 10 MB and passes the status and body through. Errors it generates itself: 401 (secret missing or wrong), 403 (another host, or a redirect to one), 405 (not GET), 400 (no or bad `url`), 502 (upstream failed, too many redirects, body too large), 500 (relay not configured). Those carry an `x-relay-error` header naming the reason, so a caller can tell the relay's own 403 from a 403 passed through from the publication, and a `Retry-After` header from upstream is forwarded so the scraper can honour a rate limit. It identifies itself with `User-Agent: substacker-relay/<version>`; it does not pretend to be a browser.

**Deploy it**, from a clone, with a free Cloudflare account:

```bash
npm ci                                   # at the repository root: installs the pinned wrangler (a devDependency of apps/relay)
cd apps/relay
npx wrangler login --device --scopes account:read user:read workers_scripts:write
npm run deploy -- --var ALLOWED_HOST:<publication>.substack.com
npx wrangler secret put RELAY_SECRET     # paste a long random value, e.g. from: openssl rand -base64 32
```

A plain `wrangler login` asks for about 30 permissions (KV, D1, Pages, zones and more); the `--scopes` above limits the grant to what a deploy and `secret put` need. `--device` is for containers and remote shells, where the default login redirects to `localhost:8976`, which your browser cannot reach; it prints a code and a URL to open on your own machine. These three scopes are the minimum we expect to work and have not been exercised against a real account: if `deploy` fails with a permission error, add `workers:write` and log in again (`npx wrangler login --scopes-list` lists the names). Run `npx wrangler logout` when you are done.

**Alternative: a scoped API token, nothing stored on the machine.** In the Cloudflare dashboard, My Profile, API Tokens, Create Token, use the "Edit Cloudflare Workers" template, then keep only Account, Workers Scripts, Edit and Account, Account Settings, Read; set Account Resources to your account alone; remove the zone rows; and give it an expiry a day or two ahead. Export it for the deploy only, then delete the token:

```bash
export CLOUDFLARE_API_TOKEN=<token> CLOUDFLARE_ACCOUNT_ID=<account id, from the dashboard URL>
npm run deploy -- --var ALLOWED_HOST:<publication>.substack.com
npx wrangler secret put RELAY_SECRET
```

`wrangler deploy` prints the Worker's address (`https://substacker-relay.<your-subdomain>.workers.dev`). `wrangler.toml` holds only a placeholder `ALLOWED_HOST` and no account id or secret; wrangler is pinned in `apps/relay/package.json`, so `npx wrangler` runs that copy and never downloads one. Pass your own host with `--var` on every deploy, or edit it locally and do not commit it.

**Tell the scraper about it:**

1. Repository, Settings, Secrets and variables, Actions, **Secrets**: create `SUBSTACKER_RELAY_SECRET` with the same value you gave `wrangler secret put`.
2. Add `"relayUrl": "https://substacker-relay.<your-subdomain>.workers.dev"` to the `SUBSTACKER_CONFIG` repository **variable** (the address is not secret).
3. Locally, export `SUBSTACKER_RELAY_SECRET` and put the same `relayUrl` in `substacker.config.local.json`.

When `relayUrl` is set the scraper requires `SUBSTACKER_RELAY_SECRET` and fetches only the feed through the relay; images are fetched directly, since they come from several hosts.

**Test result (2026-11-09):** GitHub-hosted runners get HTTP 403 from the feed whatever user agent they send, and the Cloudflare relay got HTTP 429. That is why `local` is the default mode. Networks change; to try the relay again, set `SUBSTACKER_SCRAPE` to `ci`, deploy the relay and run the `publish` workflow by hand. If the feed fetch still fails, set the variable back to `local`.

## 3b. How the scraper treats the network and images

**Politeness.** Images are downloaded with at most 4 requests in flight (`maxConcurrentDownloads`, 1 to 8) and at most 2 per host, with a short, jittered pause between requests to the same host. An answer of `429` or `503` is retried up to 3 times; the wait is the `Retry-After` header (seconds or an HTTP date) capped at 60 s, or an exponential backoff with jitter if there is none. If a host keeps answering `429`, no more requests go to it in that run (logged once): its images are left for the next run and the posts stay `unlocalized`. The feed and the relay get the same bounded retries (one sequence, then a clear error). Requests send `User-Agent: substacker-scraper/<version>`. A feed item that has no valid date is skipped with a warning and never stored; a stored item the build cannot derive is skipped with a warning too.

**Limits and safety.** A request times out after 30 s and a download is cut off while streaming at 50 MB (10 MB for the feed). Only https addresses are fetched. Every redirect hop (at most 5) is checked again, and a name is resolved once, inside the connection, so the connection goes to the address that was checked: loopback, private (RFC 1918), shared (100.64.0.0/10), link-local (including 169.254.169.254), unique-local and unspecified addresses, IPv4-mapped IPv6 and decimal, hex or octal forms of them are refused, which stops a hostile feed item from making the runner read an internal service. A refused image counts as a failed download. Residual risk: this relies on Node's `lookup` hook of `http.request`, tested here against a local server and a stub resolver but not against a live rebinding attack; a proxy configured around Node, or an `https` address that is itself public but forwards inwards, is outside what the scraper can see. The environment variable `SUBSTACKER_UNSAFE_ALLOW_PRIVATE_NETWORK=1` turns the address and https checks off for the test suites and the publish dry run, which serve a fixture feed from loopback. It is not part of the configuration; never set it in the workflow.

**SVG images** are kept, but sanitized before they are stored (and again when the build copies them): DOMPurify's SVG profile removes script, event handlers, `foreignObject` and animation; on top of that every `href` other than a `#fragment` or a raster `data:image/` is removed, and so are styles that contain `url(`, `@import`, escapes or `expression(`; the `<?xml-stylesheet` instruction and any doctype or entity are dropped by re-serialising only the `<svg>` element. An SVG with nothing valid left is a failed download, retried next run. An SVG already stored is not downloaded again.

## 3c. Local mode: scrape on a machine you control

`npm run scrape:local` (`scripts/scrape-local.mjs`) does this on the machine that runs it, in order:

1. Fetches `origin/content` and keeps a git worktree of it at `./content` (gitignored): created on the first run, fast-forwarded on later ones. A worktree with uncommitted changes is refused, not touched; nothing is ever reset, discarded or force-pushed.
2. Runs the built scraper into it, stages `raw/` and `images/` and commits only if something changed (`backup: <n> new or changed items, <m> images`, with your own git identity).
3. Pushes `content` (a plain push; if it is rejected because another machine pushed first, it fetches, merges and tries once more, then fails).
4. After pushing a new commit, asks GitHub to run the `publish` workflow, if a token is set. A failure here is a warning, never an error.
5. Prints one summary line. Exit codes: 0 done (including nothing new), 1 failure, 2 usage error or another run in progress. A lock in the repository's `.git` directory stops two runs from overlapping; a lock left by a dead process or older than six hours is taken over.

Options: `--init` (create the empty orphan `content` branch on origin, once), `--dry-run` (scrape and commit in `./content`, push nothing, dispatch nothing; a later real run pushes that commit), `--no-dispatch`, and `--content-dir <path>` (keep `content` as a standalone single-branch clone at `<path>` instead of a worktree, with the remote from `SUBSTACKER_CONTENT_REMOTE` or `--remote <url>` and the identity from `SUBSTACKER_GIT_NAME`/`SUBSTACKER_GIT_EMAIL` when the clone has none; `--init` then creates the branch on the remote if it is missing). This is the mode the container (3d) uses; the lock is then in `<path>/.git`.

**First time**, on the machine that will scrape:

```bash
git clone https://github.com/<you>/<your-fork>.git && cd <your-fork>
npm ci && npm run build
cp substacker.config.example.json substacker.config.local.json   # edit feedUrl and feedName; gitignored
git config user.name "Your Name" && git config user.email "you@example.com"   # if not set globally
npm run scrape:local -- --init --no-dispatch     # creates origin/content if missing, then the first backup
```

Then protect `content` (step 4), enable Pages (step 3), set the `SUBSTACKER_CONFIG` variable (step 2), and run the `publish` workflow by hand once. Do the one-time reset of step 1 *before* the ruleset. The machine needs credentials to push to your repository that work unattended (an SSH key or a credential helper); the dispatch token below is a separate thing.

**The dispatch token.** Create a fine-grained personal access token (GitHub, Settings, Developer settings, Personal access tokens, Fine-grained tokens): Resource owner yourself, Repository access *Only select repositories* and just this repository, repository permissions **Actions: Read and write** (this is what starts a workflow run) and **Contents: Read and write** (needed only if you also use the token as the HTTPS credential for the push; Metadata read is added automatically), and an expiry (90 days is reasonable; put the date in your calendar). The script reads it from `SUBSTACKER_DISPATCH_TOKEN` (or `GITHUB_TOKEN` or `GH_TOKEN`), sends it only to `api.github.com` and never prints it. The repository is taken from the `origin` remote (https or ssh form); `SUBSTACKER_REPO=owner/repo` overrides it. Without a token everything still works and the deploy waits for the daily schedule. When it expires you get a warning (HTTP 401) and the same fallback.

Keep the token out of the configuration document (`SUBSTACKER_CONFIG`, `substacker.config.local.json`) and out of the shell history: put it in a file only you can read, outside the repository, and let the service or cron job load it.

```bash
mkdir -p ~/.config/substacker && umask 077
read -rs -p "Token: " t && printf 'SUBSTACKER_DISPATCH_TOKEN=%s\n' "$t" > ~/.config/substacker/env; unset t
```

`read -s` neither echoes the token nor stores it in the history.

**A Linux box with a systemd timer** (as your own user; `loginctl enable-linger $USER` lets user timers run when you are logged out). `~/.config/systemd/user/substacker-scrape.service`:

```ini
[Unit]
Description=Back up the feed to the content branch
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
WorkingDirectory=%h/substacker
EnvironmentFile=%h/.config/substacker/env
ExecStart=/usr/bin/node scripts/scrape-local.mjs
```

`~/.config/systemd/user/substacker-scrape.timer`:

```ini
[Unit]
Description=Back up the feed daily

[Timer]
OnCalendar=*-*-* 04:00:00
RandomizedDelaySec=20min
Persistent=true

[Install]
WantedBy=timers.target
```

```bash
systemctl --user daemon-reload && systemctl --user enable --now substacker-scrape.timer
systemctl --user list-timers substacker-scrape.timer
systemctl --user start substacker-scrape.service     # run it now
```

`Persistent=true` runs a missed run when the machine comes back. Set the hour before the workflow's own schedule (05:17 UTC) if you want the schedule to find fresh data; with a token the dispatch deploys right after the push anyway. Use the path to the `node` you installed (`command -v node`).

**Or cron** (`crontab -e`):

```cron
17 4 * * * cd $HOME/substacker && set -a && . $HOME/.config/substacker/env && set +a && /usr/bin/node scripts/scrape-local.mjs >> $HOME/.cache/substacker-scrape.log 2>&1
```

**A laptop**: cron works the same on macOS and Linux, but it only fires while the laptop is awake. On macOS, a launchd agent with `StartCalendarInterval` (`~/Library/LaunchAgents/`, `ProgramArguments` running `node scripts/scrape-local.mjs` with `WorkingDirectory` set to the clone) runs a missed job when the Mac wakes. Or just run `npm run scrape:local` by hand when you remember; the feed carries the latest 20 items, so a gap of a few weeks of normal posting is still caught up.

**How to check it worked.** The summary line says `pushed` and `deploy requested`; `git log origin/content -3` shows the `backup:` commit; the Actions tab shows a `publish` run started by `workflow_dispatch`; the site shows the new post. A timer: `journalctl --user -u substacker-scrape.service -n 30`.

**If a day is missed** (laptop off, token expired, network down): nothing is lost. The feed carries the latest 20 items, so the next successful run stores every post published in the meantime, as long as fewer than 20 appeared. Meanwhile the daily workflow keeps rebuilding the site from `content`. If you were away through more than 20 posts, those older ones are only on Substack; the scraper never deletes, so what is on `content` stays.

**Nothing deployment-specific is committed.** The feed address, the name and the token are in your gitignored config file, the `SUBSTACKER_CONFIG` variable and a private env file. The `content` branch holds only generated data, and no workflow file is ever put on it.

## 3d. In a container, with podman

For a host where you do not want to install Node or manage timers (a small cloud instance that already runs other containers, say), the repository builds an image that does the whole job by itself: it sleeps until a time of day, scrapes, pushes the backup to `content` and asks for the deploy, every day. The host's only job is to keep the container alive (`podman run -d --restart=always`). The container makes outbound connections only (the feed, the images, github.com, api.github.com); it listens on no port.

What is where:

| | Where | Notes |
|---|---|---|
| Code | the image ([`deploy/Dockerfile`](../deploy/Dockerfile)) | Two stages: `node:26` builds `substacker-core` and `substacker-scraper`; `node:26-slim` (with `git` and `ca-certificates`) gets their `dist`, their production dependencies and four scripts (`scrape-loop.mjs`, `scrape-local.mjs`, `healthcheck.mjs`, `site.mjs`). Both base images have an arm64 variant, so it runs natively on Ampere. It runs as uid 10001. |
| Configuration and token | podman secrets, given to the container as environment variables | **Never in the image.** The image contains no configuration, no token, no `.git`, no tests and no dev dependencies. |
| State | the volume `substacker-data`, mounted at `/data` | `/data/content` is a standalone single-branch clone of `content`; `/data/last-success` is the time of the last good run. Losing it costs nothing: the next run clones again. |

Inside the container, `scripts/scrape-loop.mjs` is the entry point. It runs `scripts/scrape-local.mjs --content-dir /data/content` (the `--content-dir` mode of 3c: a standalone clone instead of a worktree, so the code directory needs no `.git`) once a day, at `SUBSTACKER_SCHEDULE_UTC` (default `04:17`) plus a random delay of up to `SUBSTACKER_JITTER_MINUTES` (default 20, at most 120). A failed run is retried after 5, 15 and 45 minutes, then left until the next day; **the loop never exits because a run failed**, so a restart policy cannot hide an outage; the health check shows it. A clean `SIGTERM`/`SIGINT` stops a running scrape and exits within seconds.

| Variable | Needed | Meaning |
|---|---|---|
| `SUBSTACKER_CONFIG` | yes | The configuration JSON (step 2), from a secret. |
| `SUBSTACKER_DISPATCH_TOKEN` | yes, for pushing | One token for both the HTTPS push (through a git credential helper baked into the image as environment, which reads this variable) and the deploy dispatch. See "The dispatch token" in 3c; it needs **Contents** and **Actions**, read and write. From a secret. |
| `SUBSTACKER_CONTENT_REMOTE` | yes | The https address of your repository, e.g. `https://github.com/<you>/<your-fork>.git`. The repository for the dispatch is taken from it. Plain `http` is refused. |
| `SUBSTACKER_GIT_NAME`, `SUBSTACKER_GIT_EMAIL` | yes, unless the clone already has an identity | The author of the `backup:` commits; stored in the clone the first time. |
| `SUBSTACKER_SCHEDULE_UTC`, `SUBSTACKER_JITTER_MINUTES` | no | When to run, as above. |
| `SUBSTACKER_RUN_ON_START=1` | no | Also scrape once when the container starts (default off). |

The commands are for rootless podman 5 as your normal user. Replace `<you>/<your-fork>` with your repository.

**1. Build the image.** `podman build` can take a git URL, but it runs `git` on the host to fetch it; a host without git (as in the minimal case this section is for) fails with `exec: "git": executable file not found`. So fetch the source with the node container, build from that directory, and delete it:

```bash
mkdir -p ~/substacker-src
podman run --rm -v ~/substacker-src:/src:Z -w / docker.io/library/node:26 \
  git clone --depth 1 --branch main https://github.com/<you>/<your-fork>.git /src
# VERSION only labels the image; read it from the clone (no Node needed on the host)
VERSION="$(sed -n 's/^  "version": "\(.*\)",$/\1/p' ~/substacker-src/package.json)"
podman build -f ~/substacker-src/deploy/Dockerfile --build-arg VERSION="$VERSION" -t substacker ~/substacker-src
podman image inspect substacker --format '{{.Architecture}} {{.Config.User}} {{index .Config.Labels "org.opencontainers.image.version"}}'   # expect arm64 (on Ampere), the non-root user and the version
rm -rf ~/substacker-src
```

Use another `--branch` to try one that is not merged yet (or `--branch v0.1.0` for a release tag; see [releasing.md](releasing.md)). The image carries the labels `org.opencontainers.image.version` (the `VERSION` build argument, `dev` if you leave it out), `.title` and `.source`. If the host has git, `podman build -f deploy/Dockerfile -t substacker https://github.com/<you>/<your-fork>.git#main` does the same in one command (the version label is then `dev`). For a private fork, clone it yourself and build from the clone. The image is named `localhost/substacker`; there is no registry.

**2. Create the secrets**, without anything entering the shell history. The configuration goes through a file only you can read (edit it from the template `substacker.config.example.json`), the token through a silent prompt:

```bash
umask 077
cp substacker.config.example.json ~/substacker-config.json     # or write it from scratch
${EDITOR:-vi} ~/substacker-config.json                          # feedUrl, feedName, ...
podman secret create substacker_config ~/substacker-config.json
rm ~/substacker-config.json

read -rs -p "Token: " t; echo; printf %s "$t" | podman secret create substacker_token -; unset t
```

`podman secret ls` lists them. Podman's default secret store keeps them unencrypted in your home directory, readable only by you: the protection is the file permissions, which is why the token must be scoped tightly (below).

**3. The one-off first run.** It creates the volume, clones (creating the `content` branch if the repository has none), scrapes, pushes, and writes `last-success`. `--no-dispatch` leaves the deploy to the daily schedule or to your first manual run of the workflow; drop it, or use `--dry-run` instead of `--init --no-dispatch`, to look first (`--dry-run` scrapes and commits in the volume, pushes nothing).

```bash
podman run --rm -v substacker-data:/data \
  --secret substacker_config,type=env,target=SUBSTACKER_CONFIG \
  --secret substacker_token,type=env,target=SUBSTACKER_DISPATCH_TOKEN \
  -e SUBSTACKER_CONTENT_REMOTE=https://github.com/<you>/<your-fork>.git \
  -e SUBSTACKER_GIT_NAME="Your Name" -e SUBSTACKER_GIT_EMAIL=you@example.com \
  substacker --once --init --no-dispatch
```

Do the one-time reset (step 1) and the `content` ruleset (step 4) before this, and read the output: it ends with a `scrape:local: pushed ...` line, or `nothing new`. The exit code is the script's (0 done, 1 failure, 2 usage or another run in progress).

**4. The long-running container**, same volume, secrets and variables:

```bash
podman run -d --name substacker --restart=always \
  --read-only --tmpfs /tmp --cap-drop=all --security-opt no-new-privileges \
  -v substacker-data:/data \
  --secret substacker_config,type=env,target=SUBSTACKER_CONFIG \
  --secret substacker_token,type=env,target=SUBSTACKER_DISPATCH_TOKEN \
  -e SUBSTACKER_CONTENT_REMOTE=https://github.com/<you>/<your-fork>.git \
  -e SUBSTACKER_GIT_NAME="Your Name" -e SUBSTACKER_GIT_EMAIL=you@example.com \
  --health-cmd 'node scripts/healthcheck.mjs' --health-interval 6h --health-start-period 1m --health-retries 1 \
  substacker
```

Required: `-d --name --restart=always`, the volume, the two secrets and the remote. Optional hardening: `--read-only` (the container writes only to `/data` and `/tmp`; podman also mounts `/tmp`, `/run` and `/dev` as tmpfs under `--read-only`, so `--tmpfs /tmp` only makes it explicit), `--cap-drop=all` (nothing here needs a capability) and `--security-opt no-new-privileges`. No `-v` with `:Z` or `:U` is needed: a named volume is labelled for SELinux by podman and takes the image's ownership of `/data` (uid 10001). If you prefer a bind mount instead, create the directory and use `-v /path:/data:Z,U`. The `--health-*` flags repeat the image's `HEALTHCHECK` on purpose: images that podman builds in its default OCI format drop `HEALTHCHECK` (it needs `--format docker`), so the flags on `podman run` are what count. Add `-e SUBSTACKER_RUN_ON_START=1` to also scrape when the container starts.

**How to see it working.**

```bash
podman logs -f substacker             # one timestamped line per event: next scrape at ..., scrape finished
podman ps --filter name=substacker    # STATUS shows (healthy) or (unhealthy)
podman healthcheck run substacker     # exit code 0 = healthy, 1 = unhealthy
podman exec substacker cat /data/last-success
git log origin/content -3             # from any clone: the backup: commit
```

The Actions tab shows a `publish` run started by `workflow_dispatch` after each new commit. Healthy means a successful run (including "nothing new") in the last 36 hours, or a container younger than that that has not had its first run; otherwise `unhealthy: last successful scrape N h ago`. A failing run is retried three times and logged; look at `podman logs` for the reason (an expired token shows as an authentication failure or HTTP 401).

**Surviving a reboot.** A container with `--restart=always` is restarted at boot only if the user's podman runs then:

```bash
loginctl enable-linger $USER
systemctl --user enable --now podman-restart.service
```

If you later manage the host with Terraform, replace this with a Quadlet unit (`~/.config/containers/systemd/substacker.container`) that names the same image, secrets, volume and variables; nothing in the image changes.

**Updating.** Rebuild from the URL, then recreate the container with the same flags (the volume keeps the clone, so nothing is cloned again):

```bash
# fetch the source again as in step 1, then:
VERSION="$(sed -n 's/^  "version": "\(.*\)",$/\1/p' ~/substacker-src/package.json)"
podman build --pull=newer -f ~/substacker-src/deploy/Dockerfile --build-arg VERSION="$VERSION" -t substacker ~/substacker-src && rm -rf ~/substacker-src
podman stop substacker && podman rm substacker
# ...then the `podman run -d ...` command from step 4 again
```

A secret is read when the container is created, so to rotate the token: `podman secret rm substacker_token`, create it again (step 2), and recreate the container. Rebuild with `--pull=newer` roughly monthly to pick up the base images' security updates; the floating `node:26` tags are acceptable for a personal job (pin a digest for strictness). Anonymous pulls from Docker Hub can hit a rate limit; `podman login docker.io` fixes it.

**Why the token must be tightly scoped.** It can write to the repository, and `main` holds the workflows. Limit it to this repository, give it an expiry, and add a ruleset on `main` and `dev` that requires a pull request with no bypass for you, so the token can write `content` and nothing else. Anyone who can run commands as your user on the host can read the secret store.

**What the image does not contain:** no configuration, no token, no `.git`, no tests, no dev dependencies, no workflow files. The build context is a whitelist (`.dockerignore`), so a stray `substacker.config.local.json` cannot enter it, and CI checks these properties on every change (the `container` job).

**Not verified.** None of this has run on a real host yet. Specifically: the image has not been built or started by a container engine by the author (none was available); the Dockerfile's steps were reproduced with plain `npm` and `git` on a Node 26 machine, and the scheduler, the health check and the `--content-dir` mode are covered by tests against a local bare repository and a local feed, but not inside a container. CI builds `linux/amd64` only; arm64 (Oracle Ampere) is built by you, with the same Dockerfile. The podman flags above follow podman's documentation for version 5 and have not been tried under SELinux; the secret-as-environment flags, `podman healthcheck run` and the `podman-restart.service` unit are the first things to confirm. A live push and dispatch from the container, a reboot, and an expired-token day are untested.

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

Prerequisites: Node.js 26 or newer (the current LTS; 22 reaches end of life in 2027) and npm. There is no Docker and no database.

```bash
git clone https://github.com/unixwars/substacker.git
cd substacker
npm ci
npm run build
```

To run the scraper and push its result, use `npm run scrape:local` (step 3c). To run the scraper by hand, create `substacker.config.local.json` (see step 2), have the `content` branch in `content/` (`npm run scrape:local -- --dry-run` sets up the worktree, or use an empty directory), then run `node packages/scraper/dist/bin/scrape.js --backup content` and `node packages/scraper/dist/bin/build.js --backup content --out site/content` (both accept `--help`). Run the built files by path, not with `npx substacker-scrape`: npm links a workspace's commands only after `npm run build`, and when one is missing `npx` would download and run a package of that name from the registry.

## Repository variables and secrets

| Name | Kind | Used by |
|---|---|---|
| `SUBSTACKER_CONFIG` | Actions variable | publish workflow; the configuration JSON (step 2) |
| `SUBSTACKER_SCRAPE` | Actions variable | publish workflow; `local` (default) or `ci` (see "Two modes") |
| `SUBSTACKER_RELAY_SECRET` | Actions secret | only in `ci` mode with `relayUrl`; sent to the relay as the `x-relay-secret` header, and the same value as the Worker's `RELAY_SECRET` |
| `SUBSTACKER_DISPATCH_TOKEN` | Environment of the scraping machine, not a repository setting | `scrape:local`; the fine-grained token that starts the workflow (step 3c). `GITHUB_TOKEN` and `GH_TOKEN` are read too. |
| `SUBSTACKER_REPO` | Same | optional `owner/repo` for the dispatch when `origin` is not a github.com address |

CI (`.github/workflows/ci.yml`) needs neither: its tests use fixtures and no real feed.

## What the workflow does, and a dry run

In `local` mode (the default) `publish.yml` checks that `content` holds posts (if not, it fails and says to run `npm run scrape:local -- --init`, rather than deploy an empty site), builds the shell and the served files into one site, checks its size (fails above 800 MB) and deploys it. In `ci` mode it first scrapes into the `content` branch and commits the backup only if it changed. Every one of those steps is a subcommand of `scripts/publish.mjs` (`scrape`, `commit`, `check`, `shell`, `content`, `site`, `size`), the mode is read there, and the dry run calls the same functions, so the two cannot drift. To see the steps locally without pushing anything:

```bash
npm run build
npm run publish:dry-run -- --mode ci         # fixture feed served locally; prints what it would commit and deploy
npm run publish:dry-run -- --mode local      # no scrape, nothing to commit; still lists the files it would deploy
node scripts/publish-dry-run.mjs --mode ci --workdir /tmp/dry   # run twice: the second run would commit nothing
```

## 5. If the schedule lapses

GitHub disables scheduled workflows after 60 days without repository activity. If the daily run stops, re-enable it in the Actions tab or run it by hand. In `local` mode, whether your pushes to `content` keep the schedule enabled is not known; it is on the plan's final checklist. Check the Actions tab now and then.

## Serving the shell under a path

The shell uses hash routes (`#/p/<slug>`), so any static host can serve it and a reload never needs server rewrites. Vite's base comes from the environment when building (the publish workflow uses the relative base `./`, which works under any path):

```bash
SUBSTACKER_BASE=/my-repo/ npm run build -w substacker-shell   # project Pages site
SUBSTACKER_BASE=./        npm run build -w substacker-shell   # relative: works under any path
```

The default is `/`. The shell reads `config.json` from its own folder (`contentUrl`, `feedName`, `subscribeUrl`, `actions`, `utmSource`, and optionally `offlineCapBytes`, default 50 MB), and the publish workflow writes it from the resolved configuration.

Offline reading is handled by a service worker generated at build time (`sw.js`, with the list of files to precache). Project Pages sites share one origin with all of their owner's other sites, so its cache names and its IndexedDB database carry a prefix taken from the base path (`substacker:/my-repo/:`) and cleanup only touches that prefix. The worker handles content under the shell's own path (`index.json`, `search.json` and `config.json` are served stale-while-revalidate; posts and images are stored when opened); a content address on another origin is not cached. `config.json` and the content's `index.json` are stored when the worker installs, so a first visit followed by going offline works without a reload. Only navigations to the shell itself (its folder, or `index.html` in it) are answered from the cache; on a site served from the root of its origin, every other path on that origin goes to the network untouched. The worker's build id is a hash of the contents of the files it stores, so changing the manifest or an icon replaces the worker. A post that the server answers with a 5xx is served from the copy kept from before, and a failing IndexedDB (it only records the eviction order) never breaks a fetch.

## Icons and the manifest

The icons come from `docs/assets/substacker-icon.webp` (full colour) and `docs/assets/substacker-icon.svg` (the glyph). `npm run icons -w substacker-shell` regenerates `icon-192.png`, `icon-512.png`, `icon-maskable-512.png` (the icon at 80% on its own background colour, inside the maskable safe zone), `apple-touch-icon.png` and the vector `icon.svg` in `apps/shell/public/`. The PNGs are committed, so a build and CI need no image tooling; run the script only if you replace the sources (it uses the `sharp` devDependency of `apps/shell`).

`manifest.webmanifest` is generated by the shell's Vite build: `name` is the `feedName` of the shell's `config.json` and `short_name` is derived from it. The build reads the file named by `SUBSTACKER_SHELL_CONFIG` (the publish workflow sets it); without it, as in `npm run dev`, the name is the neutral default `Reader`.

## Contract policy

A reader accepts every contract `version` up to its own and refuses a newer one with a clear message. The scraper rebuilds every derived file on each run, so after a contract change one run fixes the content.
