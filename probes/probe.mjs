// Probe: can this machine reach the Substack feed, its images and the post API?
// Plain Node 20+, no dependencies. Never fails the job: it only reports.
//
// Configuration (same document the project uses; no publication is named here):
//   SUBSTACKER_CONFIG   JSON with "feedUrl", else
//   substacker.config.local.json in the working directory.
// Output: a markdown report on stdout, also appended to $GITHUB_STEP_SUMMARY.

import { readFileSync, appendFileSync } from "node:fs";

const lines = [];
const out = (s = "") => { lines.push(s); console.log(s); };

function configFromEnv() {
  const raw = process.env.SUBSTACKER_CONFIG?.trim()
    || (() => { try { return readFileSync("substacker.config.local.json", "utf8"); } catch { return ""; } })();
  if (!raw) throw new Error("No SUBSTACKER_CONFIG and no substacker.config.local.json");
  let cfg;
  try { cfg = JSON.parse(raw); } catch {
    throw new Error('SUBSTACKER_CONFIG must be JSON like {"feedUrl": "https://<name>.substack.com/feed"}, not a bare URL');
  }
  if (typeof cfg.feedUrl !== "string") throw new Error('Configuration has no "feedUrl"');
  return cfg;
}

// Requested test: does a browser user agent change what Substack returns to Actions?
const PROBE_UA = "substacker-probe/0";
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36";
async function get(url, label, ua = BROWSER_UA, extraHeaders = {}) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { redirect: "manual", headers: { "user-agent": ua, ...extraHeaders } });
    const buf = await res.arrayBuffer();
    const location = res.headers.get("location");
    out(`| ${label} | ${new URL(url).host} | ${res.status}${location ? ` → ${new URL(location, url).host}` : ""} | ${buf.byteLength} | ${Date.now() - t0} ms |`);
    return { status: res.status, body: Buffer.from(buf), headers: res.headers };
  } catch (e) {
    out(`| ${label} | ${new URL(url).host} | ERROR ${e.cause?.code ?? e.message} | - | ${Date.now() - t0} ms |`);
    return null;
  }
}

function imageKind(host) {
  if (host === "substackcdn.com" || host.endsWith(".substackcdn.com")) return "Substack CDN";
  if (host.includes("substack") && host.endsWith("amazonaws.com")) return "Substack S3";
  return "third party";
}

function imageUrls(xml) {
  // Item bodies may be CDATA (raw) or entity-escaped; decode so both read the same.
  const text = xml.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&#39;", "'");
  const urls = new Set();
  for (const m of text.matchAll(/(?:src|srcset|href)=["']([^"']+)["']/g)) {
    // Candidates in a srcset are separated by a comma before "http"; Substack CDN
    // URLs contain commas themselves, so a plain split(",") would truncate them.
    for (const part of m[1].split(/,\s*(?=https?:\/\/)/)) {
      const u = part.trim().split(/\s+/)[0].replaceAll("&amp;", "&");
      if (/^https?:\/\//.test(u) && /\.(png|jpe?g|gif|webp|avif)(\?|$)|\/image\/fetch\/|post-media/i.test(u)) urls.add(u);
    }
  }
  return [...urls];
}

async function main() {
  const cfg = configFromEnv();
  const feedUrl = cfg.feedUrl;
  const relaySecret = process.env.SUBSTACKER_RELAY_SECRET;
  out(`# Substack reachability probe`);
  out();
  out(`Runner: ${process.env.GITHUB_ACTIONS ? "GitHub Actions" : "local"}, node ${process.version}, ${new Date().toISOString()}`);
  out(`User agents: \`${PROBE_UA}\` for the first feed row; \`${BROWSER_UA}\` for everything else.`);
  out();
  out("| What | Host | Status | Bytes | Time |");
  out("|---|---|---|---|---|");

  await get(feedUrl, "feed (probe UA)", PROBE_UA);
  const direct = await get(feedUrl, "feed (browser UA)");

  // The relay (a Cloudflare Worker): is it deployed, does it refuse what it should,
  // and does Substack accept its requests? Our own request to it uses the probe UA.
  let relayed = null;
  if (cfg.relayUrl) {
    const via = (target) => `${cfg.relayUrl}${cfg.relayUrl.includes("?") ? "&" : "?"}url=${encodeURIComponent(target)}`;
    await get(via(feedUrl), "relay, no secret (expect 401)", PROBE_UA);
    if (relaySecret) {
      await get(via("https://example.com/"), "relay, other host (expect 403)", PROBE_UA, { "x-relay-secret": relaySecret });
      relayed = await get(via(feedUrl), "relay, feed (expect 200)", PROBE_UA, { "x-relay-secret": relaySecret });
    } else out("| relay with secret | - | skipped: SUBSTACKER_RELAY_SECRET not set | - | - |");
  } else out("| relay | - | skipped: no relayUrl in the configuration | - | - |");

  const feed = direct?.status === 200 ? direct : relayed;
  if (!feed || feed.status !== 200) {
    out();
    out(`**Feed not reachable (direct ${direct?.status ?? "error"}, via relay ${relayed?.status ?? "n/a"}).** Images and the API check were skipped.`);
    return;
  }
  out();
  out(`Feed taken ${feed === direct ? "directly" : "through the relay"}; images and the post API below are fetched directly from this runner.`);
  out();
  out("| What | Host | Status | Bytes | Time |");
  out("|---|---|---|---|---|");
  const xml = feed.body.toString("utf8");
  const items = xml.match(/<item>/g)?.length ?? 0;

  const slugs = [...xml.matchAll(/<link>https?:\/\/[^<]*?\/p\/([^<?#/]+)/g)].map((m) => m[1]);
  const imgs = imageUrls(xml);
  const byKind = new Map();
  for (const u of imgs) {
    const k = imageKind(new URL(u).host);
    if (!byKind.has(k)) byKind.set(k, u);
    // Substack wraps its S3 originals inside CDN URLs; fetch one directly as well.
    const wrapped = u.match(/\/(https%3A%2F%2F[^/?]*amazonaws\.com[^/?]*)/i);
    if (wrapped && !byKind.has("Substack S3")) byKind.set("Substack S3", decodeURIComponent(wrapped[1]));
  }
  for (const kind of ["Substack CDN", "Substack S3", "third party"]) {
    const u = byKind.get(kind);
    if (u) await get(u, `image (${kind})`);
    else out(`| image (${kind}) | - | none in feed | - | - |`);
  }

  // Numeric post id: does the public API return one for a slug?
  let idResult = "not checked (no slug found)";
  if (slugs[0]) {
    const api = new URL(`/api/v1/posts/${slugs[0]}`, feedUrl).href;
    const r = await get(api, "post API");
    if (r?.status === 200) {
      try {
        const id = JSON.parse(r.body.toString("utf8")).id;
        idResult = Number.isInteger(id) ? "yes, numeric id present" : "no numeric id in the response";
      } catch { idResult = "200 but not JSON"; }
    } else idResult = `no (status ${r?.status ?? "error"})`;
  }

  out();
  out(`Feed items: ${items}. Distinct image URLs: ${imgs.length}.`);
  out(`Numeric post id from \`/api/v1/posts/<slug>\`: ${idResult}.`);
}

try {
  await main();
} catch (e) {
  out(`Probe error: ${e.message}`);
}
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");
process.exitCode = 0;
