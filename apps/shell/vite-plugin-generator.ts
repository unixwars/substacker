import type { Plugin } from "vite";
import { VERSION } from "../../packages/core/src/version.js";
import { generatorMeta } from "./src/generator.js";

/** Adds `<meta name="generator" content="substacker <version>">` to index.html (build and dev). */
export function generatorPlugin(): Plugin {
  return { name: "substacker-generator", transformIndexHtml: () => [generatorMeta(VERSION)] };
}
