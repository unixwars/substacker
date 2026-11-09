import { readFileSync } from "node:fs";
import type { Plugin } from "vite";
import { robotsMeta } from "./src/robots.js";
import { ShellConfigSchema } from "./src/config.js";

/**
 * Adds the noindex robots meta tag to index.html unless the shell's `config.json` sets
 * `noindex: false`. The file to read is named by `SUBSTACKER_SHELL_CONFIG` (the publish
 * workflow sets it); without it, as in development, the default (noindex on) applies.
 */
export function robotsPlugin(configPath = process.env["SUBSTACKER_SHELL_CONFIG"]): Plugin {
  const noindex = () => (configPath ? ShellConfigSchema.parse(JSON.parse(readFileSync(configPath, "utf8"))).noindex : true);
  return {
    name: "substacker-robots",
    transformIndexHtml: () => {
      const tag = robotsMeta(noindex());
      return tag ? [tag] : [];
    },
  };
}
