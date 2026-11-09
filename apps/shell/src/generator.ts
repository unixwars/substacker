import { VERSION } from "substacker-core";

/** The `<meta name="generator">` tag the build adds to index.html: no visible string. */
export function generatorMeta(version: string = VERSION) {
  return { tag: "meta" as const, attrs: { name: "generator", content: `substacker ${version}` }, injectTo: "head" as const };
}
