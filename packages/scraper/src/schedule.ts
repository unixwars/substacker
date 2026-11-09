// Pure helpers for `scripts/scrape-loop.mjs` (the daily scheduler of the container) and
// `scripts/healthcheck.mjs`. Everything is UTC, so time zones and DST do not matter.

export interface Schedule {
  hour: number;
  minute: number;
}

/** `SUBSTACKER_SCHEDULE_UTC`: HH:MM in UTC, default 04:17. */
export function parseSchedule(value: string | undefined): Schedule {
  const text = (value ?? "").trim();
  if (text === "") return { hour: 4, minute: 17 };
  const m = /^(\d{1,2}):(\d{2})$/.exec(text);
  const hour = m ? Number(m[1]) : NaN;
  const minute = m ? Number(m[2]) : NaN;
  if (!m || hour > 23 || minute > 59) throw new Error(`SUBSTACKER_SCHEDULE_UTC must be HH:MM in UTC (00:00 to 23:59), not "${text}".`);
  return { hour, minute };
}

/** `SUBSTACKER_JITTER_MINUTES`: 0 to 120, default 20. */
export function parseJitterMinutes(value: string | undefined): number {
  const text = (value ?? "").trim();
  if (text === "") return 20;
  const n = Number(text);
  if (!Number.isFinite(n) || n < 0 || n > 120) throw new Error(`SUBSTACKER_JITTER_MINUTES must be a number from 0 to 120, not "${text}".`);
  return n;
}

/**
 * The next run, in epoch milliseconds: the first `schedule` time (UTC) strictly after
 * `now`, plus a random delay of up to `jitterMinutes`. `random` returns [0, 1).
 */
export function nextRunTime(now: number, schedule: Schedule, jitterMinutes: number, random: () => number): number {
  const d = new Date(now);
  let base = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), schedule.hour, schedule.minute);
  if (base <= now) base += 86_400_000; // one UTC day: no DST, so a plain addition is exact
  return base + Math.floor(random() * jitterMinutes * 60_000);
}

/** The longest single timer: one day, far below setTimeout's 2^31-1 ms limit. */
export const MAX_TIMER_MS = 24 * 3_600_000;

/** How long to sleep next when `remainingMs` is left; the caller re-reads the clock after each chunk. */
export function nextChunkMs(remainingMs: number): number {
  return Math.min(Math.max(remainingMs, 0), MAX_TIMER_MS);
}

/** Waits before the retries of a failed run: 5, 15 and 45 minutes. */
export const RETRY_DELAYS_MS: readonly number[] = [5 * 60_000, 15 * 60_000, 45 * 60_000];

/** `SUBSTACKER_RETRY_DELAYS_MS` (tests only): comma separated milliseconds. */
export function parseRetryDelays(value: string | undefined): number[] {
  const text = (value ?? "").trim();
  if (text === "") return [...RETRY_DELAYS_MS];
  const parts = text.split(",").map((p) => p.trim());
  const nums = parts.map((p) => (/^\d+$/.test(p) ? Number(p) : NaN));
  if (nums.some((n) => !Number.isFinite(n))) throw new Error(`SUBSTACKER_RETRY_DELAYS_MS must be comma separated milliseconds, not "${text}".`);
  return nums;
}

/** The container is healthy while a run succeeded within this time. */
export const HEALTH_MAX_AGE_MS = 36 * 3_600_000;

/**
 * Whether the container is healthy. A success within 36 hours is healthy. With no recent
 * success, a container that started less than 36 hours ago is still healthy (it has not
 * had its first run yet); otherwise it is not, and `reason` says why in one line.
 */
export function healthStatus(input: { now: number; lastSuccess: number | undefined; startedAt: number | undefined }): { ok: boolean; reason: string } {
  const { now, lastSuccess, startedAt } = input;
  const hours = (ms: number) => Math.floor(ms / 3_600_000);
  if (lastSuccess !== undefined && now - lastSuccess <= HEALTH_MAX_AGE_MS) {
    return { ok: true, reason: `last success ${hours(now - lastSuccess)} h ago` };
  }
  if (startedAt !== undefined && now - startedAt < HEALTH_MAX_AGE_MS) {
    return { ok: true, reason: `started ${hours(now - startedAt)} h ago, no recent success yet` };
  }
  const what = lastSuccess === undefined ? "no successful scrape recorded" : `last successful scrape ${hours(now - lastSuccess)} h ago`;
  return { ok: false, reason: `unhealthy: ${what} (limit 36 h)` };
}
