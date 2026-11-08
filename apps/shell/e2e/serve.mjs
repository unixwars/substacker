// Minimal static file server for the e2e sites. No dependencies.
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const siteRoot = join(dirname(fileURLToPath(import.meta.url)), "..", ".e2e", "site");
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".jpeg": "image/png", ".bin": "image/png", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json" };

createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  let path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
  let file = join(siteRoot, path);
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
  if (!file.startsWith(siteRoot) || !existsSync(file)) {
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
    return;
  }
  res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream", "access-control-allow-origin": "*" });
  createReadStream(file).pipe(res);
}).listen(4173, "127.0.0.1", () => console.log("serving on http://127.0.0.1:4173"));
