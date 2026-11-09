import { readFileSync } from "node:fs";
import type { Plugin } from "vite";
import { manifestFor } from "./src/manifest.js";
import { ShellConfigSchema } from "./src/config.js";

/**
 * Emit `manifest.webmanifest` with the app name taken from `feedName` in the shell's
 * `config.json`. The file to read is named by `SUBSTACKER_SHELL_CONFIG` (the publish
 * workflow writes `config.json` from the resolved configuration, then points here);
 * without it, as in development, a neutral default name is used.
 */
export function manifestPlugin(configPath = process.env["SUBSTACKER_SHELL_CONFIG"]): Plugin {
  const body = () => {
    const config = configPath ? ShellConfigSchema.parse(JSON.parse(readFileSync(configPath, "utf8"))) : undefined;
    return `${JSON.stringify(manifestFor(config), null, 2)}\n`;
  };
  return {
    name: "substacker-manifest",
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "manifest.webmanifest", source: body() });
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.split("?")[0]?.endsWith("/manifest.webmanifest")) {
          res.setHeader("content-type", "application/manifest+json");
          res.end(body());
        } else next();
      });
    },
  };
}
