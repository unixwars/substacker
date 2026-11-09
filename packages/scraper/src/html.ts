import { JSDOM } from "jsdom";
import type { DomParser } from "substacker-core/dom";

let shared: JSDOM | undefined;

/** The window the sanitizer runs in when Node does the work. */
export const jsdomWindow: DomParser = () => {
  shared ??= new JSDOM("");
  return shared.window as unknown as ReturnType<DomParser>;
};

/** Plain text of an HTML fragment, whitespace collapsed. */
export function textOf(html: string): string {
  const doc = new JSDOM(`<!doctype html><body>${html}</body>`).window.document;
  for (const el of doc.querySelectorAll("script, style")) el.remove();
  // Keep block boundaries as spaces so words do not run together.
  for (const el of doc.querySelectorAll("p, div, li, br, h1, h2, h3, h4, h5, h6, blockquote, figcaption, tr")) {
    el.append(doc.createTextNode(" "));
  }
  return (doc.body.textContent ?? "").replace(/\s+/g, " ").trim();
}
