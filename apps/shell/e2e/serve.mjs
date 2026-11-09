// Minimal static file server for the e2e sites. No dependencies.
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const siteRoot = join(dirname(fileURLToPath(import.meta.url)), "..", ".e2e", "site");
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json" };

// Tests can make the server answer 500 for posts: GET /__control/fail-posts/on or /off.
let failPosts = false;

function serve(root, port) {
  createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname.startsWith("/__control/fail-posts/")) {
      failPosts = url.pathname.endsWith("/on");
      res.writeHead(204, { "access-control-allow-origin": "*" }).end();
      return;
    }
    if (failPosts && /\/posts\/[^/]+\.json$/.test(url.pathname)) {
      res.writeHead(500, { "content-type": "text/plain", "access-control-allow-origin": "*" }).end("server error");
      return;
    }
    const path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
    let file = join(root, path);
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
    if (!file.startsWith(root) || !existsSync(file)) {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
      return;
    }
    res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream", "access-control-allow-origin": "*" });
    createReadStream(file).pipe(res);
  }).listen(port, "127.0.0.1", () => console.log(`serving ${root} on http://127.0.0.1:${port}`));
}

// Every scenario under its own path on 4173; the `root` scenario is also the root of its own
// origin on 4174, next to a page that is not part of the shell.
serve(siteRoot, 4173);
serve(join(siteRoot, "root"), 4174);
