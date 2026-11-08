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
