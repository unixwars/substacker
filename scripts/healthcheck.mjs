// The container's health check: exit 0 while a scrape succeeded in the last 36 hours, or
// while the container is younger than that and has not had a run yet; else exit 1 with a
// one-line reason. Reads <data>/last-success (written by scrape-loop.mjs) and a start
// marker under /tmp. A missing marker is created now, so a fresh container is healthy.
//
//   SUBSTACKER_DATA_DIR  default /data
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { scraperModule } from "./site.mjs";

function readTime(file) {
  try {
    const t = Date.parse(readFileSync(file, "utf8").trim());
    return Number.isNaN(t) ? undefined : t;
  } catch {
    return undefined;
  }
}

export async function main(env = process.env, now = Date.now()) {
  const { healthStatus } = await scraperModule("schedule");
  const dataDir = env["SUBSTACKER_DATA_DIR"] || "/data";
  const marker = env["SUBSTACKER_START_MARKER"] || "/tmp/substacker-started";
  let startedAt = readTime(marker);
  if (startedAt === undefined) {
    startedAt = now;
    try {
      mkdirSync(dirname(marker), { recursive: true });
      writeFileSync(marker, `${new Date(now).toISOString()}\n`);
    } catch {
      // A read-only /tmp: the benefit of the doubt applies to this check only.
    }
  }
  const status = healthStatus({ now, lastSuccess: readTime(join(dataDir, "last-success")), startedAt });
  console.log(status.reason);
  return status.ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.log(`unhealthy: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    },
  );
}
