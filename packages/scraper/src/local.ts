// Pure helpers for `scripts/scrape-local.mjs`, the scrape that runs on a machine the
// owner controls. They live here so the repository's unit tests cover them.

/**
 * `owner/repo` from a GitHub remote address (https, scp-like ssh or ssh://), or
 * undefined for anything else. With `bare`, the text is already `owner/repo`.
 */
export function parseRepoSlug(text: string, opts: { bare?: boolean } = {}): string | undefined {
  const t = text.trim();
  const part = "[A-Za-z0-9_.-]+";
  const match = opts.bare
    ? new RegExp(`^(${part})/(${part})$`).exec(t)
    : (/^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/(?:[^@/]+@)?|[^@/]+@)github\.com[:/](?:\d+\/)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(t));
  const owner = match?.[1];
  const repo = match?.[2];
  if (!owner || !repo || /^\.+$/.test(owner) || /^\.+$/.test(repo)) return undefined;
  return `${owner}/${repo}`;
}

/** How many raw items and images a list of staged paths holds. */
export function summarizeStaged(files: string[]): { items: number; images: number } {
  return {
    items: files.filter((f) => f.startsWith("raw/")).length,
    images: files.filter((f) => f.startsWith("images/")).length,
  };
}

/** The backup commit message; it names no person and no bot. */
export function backupMessage({ items, images }: { items: number; images: number }): string {
  return `backup: ${items} new or changed ${items === 1 ? "item" : "items"}, ${images} ${images === 1 ? "image" : "images"}`;
}

/** The token that lets the script ask GitHub to run the deploy, if any is set. */
export function dispatchToken(env: Record<string, string | undefined>): string | undefined {
  for (const name of ["SUBSTACKER_DISPATCH_TOKEN", "GITHUB_TOKEN", "GH_TOKEN"]) {
    const v = env[name]?.trim();
    if (v) return v;
  }
  return undefined;
}

/**
 * The REST call that runs `publish.yml` on `main`. `apiBase` is https://api.github.com;
 * plain http is accepted for a loopback address only (the integration test's fake API).
 */
export function dispatchRequest(opts: { slug: string; token: string; apiBase: string }): { url: string; init: RequestInit } {
  if (!URL.canParse(opts.apiBase)) throw new Error("the API address is not a URL");
  const base = new URL(opts.apiBase);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname);
  if (base.protocol !== "https:" && !(base.protocol === "http:" && loopback)) {
    throw new Error("the API address must be https (the token travels with the request)");
  }
  return {
    url: `${opts.apiBase.replace(/\/+$/, "")}/repos/${opts.slug}/actions/workflows/publish.yml/dispatches`,
    init: {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${opts.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
        "User-Agent": "substacker-scrape-local",
      },
      body: JSON.stringify({ ref: "main" }),
    },
  };
}

export interface LockInfo {
  pid: number;
  startedAt: number;
}

/** A lock file's content, or undefined if it is not one of ours. */
export function parseLock(text: string): LockInfo | undefined {
  try {
    const v: unknown = JSON.parse(text);
    if (typeof v !== "object" || v === null) return undefined;
    const { pid, startedAt } = v as Record<string, unknown>;
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return undefined;
    if (typeof startedAt !== "number" || !Number.isFinite(startedAt)) return undefined;
    return { pid, startedAt };
  } catch {
    return undefined;
  }
}

/** A lock older than this is taken over even if its pid is alive (the pid may be reused). */
export const LOCK_MAX_AGE_MS = 6 * 3_600_000;

/** Whether a lock can be taken over: unreadable, its process gone, or too old. */
export function lockIsStale(lock: LockInfo | undefined, ctx: { now: number; alive: (pid: number) => boolean }): boolean {
  if (!lock) return true;
  if (ctx.now - lock.startedAt > LOCK_MAX_AGE_MS) return true;
  return !ctx.alive(lock.pid);
}

export type ScrapeMode = "local" | "ci";

/**
 * Where the scrape runs, from the repository variable `SUBSTACKER_SCRAPE`: `local` (the
 * default) means a machine you control pushes the backup and the workflow only builds and
 * deploys; `ci` means the workflow scrapes too.
 */
export function scrapeMode(value: string | undefined): ScrapeMode {
  const v = (value ?? "").trim().toLowerCase();
  if (v === "" || v === "local") return "local";
  if (v === "ci") return "ci";
  throw new Error(`SUBSTACKER_SCRAPE must be "local" or "ci", not "${value}".`);
}

export interface ScrapeOptions {
  init: boolean;
  dryRun: boolean;
  noDispatch: boolean;
  help: boolean;
  /** Standalone clone of `content` at this path (container mode); otherwise a worktree of the current repository. */
  contentDir?: string;
  /** The `content` remote, with `contentDir`; the environment variable is the other source. */
  remote?: string;
}

/** The command line of `scripts/scrape-local.mjs`. A bad one is a message (exit code 2). */
export function parseScrapeArgs(argv: string[]): { ok: true; options: ScrapeOptions } | { ok: false; message: string } {
  const usage = "Usage: node scripts/scrape-local.mjs [--init] [--no-dispatch] [--dry-run] [--content-dir <path> [--remote <url>]]";
  const options: ScrapeOptions = { init: false, dryRun: false, noDispatch: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--init") options.init = true;
    else if (a === "--dry-run") options.dryRun = true;
    else if (a === "--no-dispatch") options.noDispatch = true;
    else if (a === "--help") options.help = true;
    else if (a === "--content-dir" || a === "--remote") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) return { ok: false, message: `${a} needs a value. ${usage}` };
      i++;
      if (a === "--content-dir") options.contentDir = value;
      else options.remote = value;
    } else return { ok: false, message: `Unknown option ${a}. ${usage}` };
  }
  if (options.remote !== undefined && options.contentDir === undefined) return { ok: false, message: `--remote only applies with --content-dir. ${usage}` };
  if (options.init && options.dryRun) return { ok: false, message: "--init pushes a branch; it cannot be combined with --dry-run." };
  return { ok: true, options };
}

/**
 * The address of the `content` remote in `--content-dir` mode: `--remote`, else
 * `SUBSTACKER_CONTENT_REMOTE`. Plain http is refused because the token would travel with it.
 */
export function contentRemote(flag: string | undefined, env: Record<string, string | undefined>): string {
  const value = (flag ?? env["SUBSTACKER_CONTENT_REMOTE"] ?? "").trim();
  if (!value) throw new Error("No content remote. Set SUBSTACKER_CONTENT_REMOTE to the https address of the repository (or pass --remote <url>).");
  if (value.startsWith("-")) throw new Error("The content remote must be an address, not an option.");
  if (/^http:\/\//i.test(value)) throw new Error("The content remote must be https (the token travels with every push).");
  return value;
}

/** The git identity from `SUBSTACKER_GIT_NAME` and `SUBSTACKER_GIT_EMAIL`; both are needed. */
export function gitIdentity(env: Record<string, string | undefined>): { name: string; email: string } | undefined {
  const name = env["SUBSTACKER_GIT_NAME"]?.trim();
  const email = env["SUBSTACKER_GIT_EMAIL"]?.trim();
  return name && email ? { name, email } : undefined;
}
