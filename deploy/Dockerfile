# The scraper as a long-running container: it scrapes the feed once a day and pushes the
# backup to the `content` branch (scripts/scrape-loop.mjs). Build from the repository root:
#
#   podman build -f deploy/Dockerfile -t substacker \
#     --build-arg VERSION="$(node -p "require('./package.json').version")" .
#   podman build -f deploy/Dockerfile -t substacker https://github.com/<you>/<your-fork>.git#main
#
# VERSION only labels the image (org.opencontainers.image.version); a Dockerfile cannot
# read package.json, so it defaults to "dev" when the argument is not given.
#
# The image holds code and nothing else: no configuration, no token, no .git. The
# configuration (SUBSTACKER_CONFIG), the token (SUBSTACKER_DISPATCH_TOKEN) and the
# address of the repository are given when the container is created, and the state (a
# clone of `content`) lives in the volume /data. See docs/setup.md, section 3d.

# ---- build: compile the two packages the scraper needs -------------------------------
FROM node:26 AS build
WORKDIR /src
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/tsconfig.build.json packages/core/
COPY packages/scraper/package.json packages/scraper/tsconfig.build.json packages/scraper/
# --include-workspace-root brings the root's TypeScript, which -w alone leaves out.
RUN npm ci -w substacker-core -w substacker-scraper --include-workspace-root --no-audit --no-fund
COPY packages/core/src packages/core/src
COPY packages/scraper/src packages/scraper/src
RUN npm run build -w substacker-core -w substacker-scraper

# ---- runtime ---------------------------------------------------------------------------
FROM node:26-slim
ARG VERSION=dev
LABEL org.opencontainers.image.title=substacker-scraper \
      org.opencontainers.image.version=$VERSION \
      org.opencontainers.image.source=https://github.com/unixwars/substacker
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --gid 10001 substacker \
 && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin substacker \
 && mkdir /app /data \
 && chown 10001:10001 /app /data

USER 10001:10001
WORKDIR /app

# Production dependencies of the two packages only (no dev tools), from the lockfile.
COPY --chown=10001:10001 package.json package-lock.json ./
COPY --chown=10001:10001 packages/core/package.json packages/core/
COPY --chown=10001:10001 packages/scraper/package.json packages/scraper/
RUN npm ci --omit=dev -w substacker-core -w substacker-scraper --no-audit --no-fund --cache /tmp/npm-cache \
 && rm -rf /tmp/npm-cache

COPY --from=build --chown=10001:10001 /src/packages/core/dist packages/core/dist
COPY --from=build --chown=10001:10001 /src/packages/scraper/dist packages/scraper/dist
# Exactly what the two entry scripts import: site.mjs and the built scraper.
COPY --chown=10001:10001 scripts/scrape-local.mjs scripts/scrape-loop.mjs scripts/healthcheck.mjs scripts/site.mjs scripts/

# State: the clone of `content`, and the time of the last success.
VOLUME /data

ENV NODE_ENV=production \
    TZ=UTC \
    SUBSTACKER_DATA_DIR=/data \
    GIT_CONFIG_COUNT=1 \
    GIT_CONFIG_KEY_0=credential.helper \
    GIT_CONFIG_VALUE_0='!f() { echo username=x-access-token; echo "password=$SUBSTACKER_DISPATCH_TOKEN"; }; f'
# The helper reads the token from the container's environment when git asks for it, so
# the token is never written to disk or into the image.

HEALTHCHECK --interval=6h --timeout=20s --start-period=1m --retries=1 \
  CMD ["node", "scripts/healthcheck.mjs"]

ENTRYPOINT ["node", "scripts/scrape-loop.mjs"]
