// Reports the size of the assembled site and fails above the Pages budget.
//   node scripts/site-size.mjs site
import { appendFileSync } from "node:fs";
import { SITE_LIMIT_BYTES, dirSize, listFiles } from "./site.mjs";

const dir = process.argv[2] ?? "site";
const bytes = dirSize(dir);
const mb = (bytes / (1024 * 1024)).toFixed(1);
const line = `Site size: ${mb} MB in ${listFiles(dir).length} files (limit ${SITE_LIMIT_BYTES / (1024 * 1024)} MB)`;
console.log(line);
if (process.env["GITHUB_STEP_SUMMARY"]) appendFileSync(process.env["GITHUB_STEP_SUMMARY"], `${line}\n`);
if (bytes > SITE_LIMIT_BYTES) {
  console.error(`The site is over the limit; GitHub Pages allows about 1 GB. Failing.`);
  process.exit(1);
}
