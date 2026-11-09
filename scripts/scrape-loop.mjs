// The scheduler of the container: scrapes the feed once a day and pushes the backup to
// the `content` branch, forever. No cron daemon, no dependencies.
//
//   node scripts/scrape-loop.mjs                       run daily (the container's entrypoint)
//   node scripts/scrape-loop.mjs --once [flags]        one scrape now, flags go to scrape-local.mjs
//                                                      (--init, --dry-run, --no-dispatch), exit with its code
//
// Environment (all optional):
//   SUBSTACKER_SCHEDULE_UTC     HH:MM in UTC, default 04:17
//   SUBSTACKER_JITTER_MINUTES   0 to 120, default 20: a random delay after that time
//   SUBSTACKER_DATA_DIR         default /data; the clone of `content` is <data>/content,
//                               `last-success` (an ISO timestamp) is <data>/last-success
//   SUBSTACKER_RUN_ON_START=1   also scrape once at start, before the first sleep
// The scrape itself is configured as for scrape-local.mjs (SUBSTACKER_CONFIG,
// SUBSTACKER_CONTENT_REMOTE, SUBSTACKER_GIT_NAME/EMAIL, SUBSTACKER_DISPATCH_TOKEN).
// Test only: SUBSTACKER_RETRY_DELAYS_MS (default 5, 15 and 45 minutes, as milliseconds),
// SUBSTACKER_TEST_NEXT_RUN_MS (sleep this long instead of until the schedule).
//
// A failed run is retried after 5, 15 and 45 minutes, then left until the next day. The
// loop never exits because a run failed: a restart policy must not hide an outage (the
// health check shows it). It exits on SIGTERM or SIGINT, after stopping a running scrape.
// One log line per event, with a timestamp; the token and the configuration are never
// logged.
import { spawn } from "node:child_process";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { scraperModule } from "./site.mjs";

const scrapeScript = join(dirname(fileURLToPath(import.meta.url)), "scrape-local.mjs");
/** How long a scrape gets to stop after SIGTERM before it is killed. */
const STOP_GRACE_MS = 8_000;

const log = (message) => console.log(`${new Date().toISOString()} scrape-loop: ${message}`);

export function startMarkerPath(env) {
  return env["SUBSTACKER_START_MARKER"] || "/tmp/substacker-started";
}

export async function main(argv, env = process.env) {
  const sched = await scraperModule("schedule");
  const onceAt = argv.indexOf("--once");
  if (argv.includes("--help") || (onceAt < 0 && argv.length > 0)) {
    const usage = "Usage: node scripts/scrape-loop.mjs [--once [--init] [--dry-run] [--no-dispatch]]";
    if (argv.includes("--help")) {
      console.log(usage);
      return 0;
    }
    console.error(`Unknown argument ${argv[0]}. ${usage}`);
    return 2;
  }

  let config;
  try {
    config = {
      schedule: sched.parseSchedule(env["SUBSTACKER_SCHEDULE_UTC"]),
      jitter: sched.parseJitterMinutes(env["SUBSTACKER_JITTER_MINUTES"]),
      retryDelays: sched.parseRetryDelays(env["SUBSTACKER_RETRY_DELAYS_MS"]),
    };
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 2;
  }
  const dataDir = env["SUBSTACKER_DATA_DIR"] || "/data";
  const contentDir = join(dataDir, "content");

  let stopping = false;
  let child; // the running scrape
  const sleepers = new Set(); // wake-up functions of the pending sleeps
  const onSignal = (signal) => {
    if (stopping) return;
    stopping = true;
    log(`${signal} received, stopping`);
    for (const wake of sleepers) wake();
    if (child) child.kill("SIGTERM");
  };
  process.on("SIGTERM", () => onSignal("SIGTERM"));
  process.on("SIGINT", () => onSignal("SIGINT"));

  /** Sleep, ending early on a stop. */
  const sleep = (ms) =>
    new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        sleepers.delete(done);
        resolve();
      }
      sleepers.add(done);
    });

  /** Sleep until `target` (epoch ms) in chunks, so no timer is long and the clock is re-read. */
  async function sleepUntil(target) {
    while (!stopping) {
      const remaining = target - Date.now();
      if (remaining <= 0) return;
      await sleep(sched.nextChunkMs(remaining));
    }
  }

  /** One scrape as a child process; resolves with its exit code (null if killed by a signal). */
  function scrapeOnce(extraArgs) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (code) => {
        if (settled) return;
        settled = true;
        child = undefined;
        resolve(code);
      };
      try {
        child = spawn(process.execPath, [scrapeScript, "--content-dir", contentDir, ...extraArgs], { stdio: "inherit", env });
      } catch (e) {
        log(`could not start the scrape: ${e instanceof Error ? e.message : String(e)}`);
        return finish(1);
      }
      const running = child;
      running.on("error", (e) => {
        log(`could not start the scrape: ${e.message}`);
        finish(1);
      });
      running.on("exit", (code) => finish(code ?? 1));
      if (stopping) running.kill("SIGTERM");
      // A scrape that ignores SIGTERM is killed after a grace period.
      const watchdog = setInterval(() => {
        if (!stopping) return;
        clearInterval(watchdog);
        setTimeout(() => running.exitCode === null && running.kill("SIGKILL"), STOP_GRACE_MS).unref();
      }, 200);
      watchdog.unref();
      running.on("exit", () => clearInterval(watchdog));
    });
  }

  function recordSuccess() {
    try {
      mkdirSync(dataDir, { recursive: true });
      const file = join(dataDir, "last-success");
      writeFileSync(`${file}.tmp`, `${new Date().toISOString()}\n`);
      renameSync(`${file}.tmp`, file);
    } catch (e) {
      log(`could not record the success: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (onceAt >= 0) {
    const extra = argv.filter((_, i) => i !== onceAt);
    const code = await scrapeOnce(extra);
    if (code === 0 && !extra.includes("--dry-run")) recordSuccess();
    return code;
  }

  /** A scrape with up to three retries; true if one succeeded. */
  async function runWithRetries() {
    const attempts = config.retryDelays.length + 1;
    for (let attempt = 1; attempt <= attempts && !stopping; attempt++) {
      log(`scrape starting (attempt ${attempt} of ${attempts})`);
      const code = await scrapeOnce([]);
      if (stopping) return false;
      if (code === 0) {
        recordSuccess();
        log("scrape finished");
        return true;
      }
      log(`scrape failed (exit ${code})`);
      const delay = config.retryDelays[attempt - 1];
      if (delay === undefined) break;
      log(`retrying in ${Math.round(delay / 1000)} s`);
      await sleepUntil(Date.now() + delay);
    }
    if (!stopping) log("giving up until the next scheduled run");
    return false;
  }

  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(startMarkerPath(env), `${new Date().toISOString()}\n`);
  } catch (e) {
    log(`could not write the start marker: ${e instanceof Error ? e.message : String(e)}`);
  }
  const testDelay = env["SUBSTACKER_TEST_NEXT_RUN_MS"] ? Number(env["SUBSTACKER_TEST_NEXT_RUN_MS"]) : undefined;
  log(`started; schedule ${String(config.schedule.hour).padStart(2, "0")}:${String(config.schedule.minute).padStart(2, "0")} UTC, jitter up to ${config.jitter} min, data in ${dataDir}`);

  if (env["SUBSTACKER_RUN_ON_START"] === "1") await runWithRetries();
  while (!stopping) {
    const next = testDelay !== undefined ? Date.now() + testDelay : sched.nextRunTime(Date.now(), config.schedule, config.jitter, Math.random);
    log(`next scrape at ${new Date(next).toISOString()}`);
    await sleepUntil(next);
    if (stopping) break;
    await runWithRetries();
  }
  log("stopped");
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    },
  );
}
