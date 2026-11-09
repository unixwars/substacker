# Releasing

How a version of substacker is cut, published and, if needed, taken back. The repository has **one version number**: the `version` of the root `package.json`. Every workspace package (`substacker-core`, `substacker-scraper`, `substacker-shell`, `substacker-relay`) carries the same number, and so do the constants in the code. Versions follow [Semantic Versioning](https://semver.org/), with the caveat that **before 1.0.0 a minor version may break** the content contract, the `substacker-core` API, the configuration or the scripts. Patch versions only fix bugs. The first release is `0.1.0`.

What is released: the GitHub Release `vX.Y.Z` with the tarball of `substacker-core`, the source at the tag, and (built by you, see below) the scraper container image. Nothing is published to the npm registry.

## Where the version appears

| Place | How it is kept in step |
|---|---|
| `package.json` of the root and of the four workspaces; `package-lock.json` | `npm version` (below) |
| `"substacker-core": "^X.Y.Z"` in `packages/scraper` and `apps/shell` | `node scripts/sync-version.mjs` |
| `VERSION` in `packages/core/src/version.ts` (exported by `substacker-core`), `packages/scraper/src/version.ts` and `apps/relay/src/version.ts` (the relay's `User-Agent: substacker-relay/<version>` and the scraper's `substacker-scraper/<version>`) | `node scripts/sync-version.mjs` writes them from the root `package.json`; they are committed so that `tsc`, Vite, the Worker bundler and the published tarball need no file access |
| `substacker-scrape --version`, `substacker-build --version`, `scripts/scrape-local.mjs --version`, `scripts/scrape-loop.mjs --version`; the line `substacker <version> started` in the container log; `<meta name="generator" content="substacker <version>">` in the shell's `index.html` | derived from the above |
| The image label `org.opencontainers.image.version` | the `VERSION` build argument (below) |

A unit test (`packages/core/src/version.test.ts`) fails if any workspace version, any generated constant or any `substacker-core` range differs from the root version, and the integration test installs the packed tarball and checks that `VERSION` equals the package version. `node scripts/sync-version.mjs --check` is the same check from the command line.

**`VERSION` is not `CONTRACT_VERSION`.** `VERSION` is the release of the software. `CONTRACT_VERSION` (also exported by `substacker-core`) is the version of the content format, the `version` field in the files the scraper writes; a reader accepts every contract version up to its own and refuses a newer one. The two move independently: most releases do not change the contract.

## Cutting a release

`dev` and `main` are protected by rulesets: every change reaches them through a pull request, and nobody bypasses them. A release is two pull requests and a tag.

1. **Branch from `dev`**, for example `chore/release-0.2.0`.
2. **Update `CHANGELOG.md`.** Move the entries under `## [Unreleased]` to a new `## [X.Y.Z] - YYYY-MM-DD` section, with the headings Added, Changed, Deprecated, Removed, Fixed, Security (only those that apply), update the link references at the bottom, and leave an empty `## [Unreleased]` above. The release workflow publishes this section as the release notes and **fails if it is missing or empty**. Check it yourself: `node scripts/changelog-section.mjs vX.Y.Z`.
3. **Bump the versions**, all at once:

   ```bash
   npm version X.Y.Z --workspaces --include-workspace-root --no-git-tag-version
   node scripts/sync-version.mjs
   npm install --package-lock-only
   ```

   `npm version` changes the five `package.json` files and the lockfile; `sync-version.mjs` rewrites the generated constants and the `substacker-core` ranges; `npm install --package-lock-only` brings the lockfile in line with those ranges. (It reports "Version not changed" if a package is already at that number.) Do not create a git tag here.
4. **Verify**: `npm run typecheck && npm run lint && npm run test:unit && npm run test:integration && npm run build && npm run test:e2e`. Commit with a message such as `chore(release): X.Y.Z`.
5. **Pull request into `dev`**, wait for CI, merge.
6. **Pull request from `dev` into `main`**, wait for CI, merge. Do not rebase or squash away the commit you intend to tag without noting the new hash.
7. **Tag the merge commit on `main`** and push **only the tag**:

   ```bash
   git fetch origin
   git tag -a vX.Y.Z -m "substacker X.Y.Z" <sha-of-the-merge-commit-on-main>
   git push origin vX.Y.Z
   ```

   For `0.1.0`: `git tag -a v0.1.0 -m "substacker 0.1.0" <sha> && git push origin v0.1.0`. Use the hash that `git log -1 origin/main` shows after the merge (`git rev-parse origin/main`). Never `git push --tags`, never force-push a tag, and do not create the GitHub Release yourself: the workflow does.
8. **Watch the `release` run** in the Actions tab (below), then check the Release page.

## What the `release` workflow does

[`.github/workflows/release.yml`](../.github/workflows/release.yml) runs on every pushed tag matching `v*`, with the only permission `contents: write` (it needs it to create the Release). On Ubuntu with Node 26, in this order, stopping at the first failure:

1. Checks out the tag with its history and checks that the tagged commit **is on `main`** (an ancestor of `origin/main`).
2. Checks that **no GitHub Release exists for the tag** yet (it fails with the way out if one does).
3. `npm ci`, then checks that the **tag equals the `substacker-core` package version** (`vX.Y.Z` against `packages/core`), that the root version is the same, and that the generated constants are current (`node scripts/sync-version.mjs --check`).
4. Extracts the section of the version from `CHANGELOG.md` with `scripts/changelog-section.mjs` and **fails with a clear message if it is missing or empty**.
5. Runs `npm run typecheck`, `npm run lint`, `npm run test:unit` and `npm run test:integration`. The integration run includes packing `substacker-core`, installing the tarball in an empty project and importing every subpath, and checking that `VERSION` equals the package version. It needs the npm registry.
6. Runs `npm pack -w substacker-core`, producing `substacker-core-X.Y.Z.tgz` (the `prepack` script builds `dist` first), and checks that the file exists.
7. Creates the GitHub Release for the tag with `gh release create --verify-tag`, titled with the tag, with the tarball attached and the changelog section as the notes. A tag whose version has a hyphen (`0.2.0-rc.1`) is marked as a pre-release.

The end-to-end Playwright tests are not part of this workflow; they run in CI on the pull requests, so run `npm run test:e2e` before you tag.

## Installing a release (embedders)

The core library is installed from the tarball on the Release page:

```bash
npm install https://github.com/unixwars/substacker/releases/download/v0.1.0/substacker-core-0.1.0.tgz
```

`package.json` then holds that URL, and `package-lock.json` pins the tarball's `integrity` hash (SHA-512), so `npm ci` refuses a file that differs from the one you first installed. To upgrade, install the new URL and read the `CHANGELOG.md` entries in between first: before 1.0.0 a minor upgrade can break. `react` is an optional peer dependency, needed only for `substacker-core/react`.

## Rebuilding the container image for a release

The image is built by you; there is no registry. Build from the tag, with the version as a build argument (the Dockerfile cannot read `package.json`; without the argument the label is `dev`):

```bash
git clone --depth 1 --branch vX.Y.Z https://github.com/unixwars/substacker.git substacker-src
podman build -f substacker-src/deploy/Dockerfile \
  --build-arg VERSION="$(node -p "require('./substacker-src/package.json').version")" \
  -t substacker substacker-src
podman image inspect substacker --format '{{index .Config.Labels "org.opencontainers.image.version"}}'
```

On a host without Node or git, use the node-container clone of [setup.md](setup.md), step 3d, with `--branch vX.Y.Z`. Then recreate the container with the same flags ("Updating" in that section). The log shows `substacker X.Y.Z started`, and `substacker-scrape-loop --version` (`podman run --rm --entrypoint node substacker scripts/scrape-loop.mjs --version`) prints the same number. CI builds the image on every change with the version label and checks it.

## The contract-version policy

`CONTRACT_VERSION` changes only when the files the scraper derives change shape in a way an older reader cannot handle. When it does:

- The release that carries it is a **minor** release before 1.0.0 (a major one after), and its changelog entry says so under a visible heading ("Changed" or "Removed") with what readers must do.
- Readers accept every contract version up to their own and refuse a newer one with a clear message, so deploy a reader that understands the new contract before (or together with) the scraper that writes it.
- The raw feed items in `content` are never rewritten. The scraper rebuilds every derived file on each run, so one run after upgrading fixes the served files.

A release that does not change the contract leaves `CONTRACT_VERSION` alone.

## If a release goes wrong

- **The workflow failed before it created the Release** (a failed check, a red test). Nothing was published. Fix the cause through the normal pull requests into `dev` and `main`, delete the tag (`git push origin :refs/tags/vX.Y.Z` and `git tag -d vX.Y.Z`), and tag the new merge commit with the same version, since no one could have installed it.
- **A Release was created and is bad** (a wrong tarball, a regression, a bad changelog). Delete the GitHub Release (Releases page, or `gh release delete vX.Y.Z`) and the tag (`git push origin :refs/tags/vX.Y.Z`), then **fix forward**: bump the patch version, add a changelog entry that says what was wrong, and release `X.Y.(Z+1)` through the steps above. **A version number that was ever published is not reused**, even after its Release is deleted: embedders' lockfiles may already pin its hash.
- **Never rewrite `main`, `dev` or `content`**: no force push, no history edit, no `git reset` on a shared branch. A release is undone by a new commit and a new version, not by changing the past.
