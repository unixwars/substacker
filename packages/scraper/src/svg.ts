import createDOMPurify from "dompurify";
import { JSDOM } from "jsdom";

const SAFE_DATA = /^data:image\/(?:png|jpe?g|gif|webp|avif|bmp);/i;
const BAD_CSS = /url\s*\(|@import|expression\s*\(|javascript:|behaviou?r\s*:|-moz-binding|\\/i;
const URL_REF = /url\s*\(\s*['"]?\s*(?!#)/i;

let purifier: ReturnType<typeof createDOMPurify> | undefined;
let window: JSDOM["window"] | undefined;

function purify() {
  if (purifier && window) return { purifier, window };
  window = new JSDOM("").window;
  const p = createDOMPurify(window as unknown as Parameters<typeof createDOMPurify>[0]);
  p.addHook("uponSanitizeElement", (node, data) => {
    // A style block may stay, unless it can load anything or hide a url behind an escape.
    if (data.tagName === "style" && BAD_CSS.test(node.textContent ?? "")) data.allowedTags["style"] = false;
  });
  p.addHook("afterSanitizeAttributes", (node) => {
    for (const attr of [...node.attributes]) {
      const name = attr.name.toLowerCase();
      const value = attr.value.trim();
      const href = name === "href" || name.endsWith(":href");
      if (href ? !(value.startsWith("#") || SAFE_DATA.test(value)) : name === "style" ? BAD_CSS.test(value) : URL_REF.test(value)) {
        node.removeAttribute(attr.name);
      }
    }
  });
  purifier = p;
  return { purifier: p, window };
}

/**
 * Make an SVG safe to store and serve from our own origin. DOMPurify's SVG profile drops
 * script, event handlers, foreignObject, animation and the like; this also removes every
 * reference that is not a `#fragment` or a raster `data:` image, style that can load
 * anything, and the processing instructions and doctype (nothing outside `<svg>` is kept).
 * Returns the re-serialised XML, or null if no `<svg>` is left.
 */
export function sanitizeSvg(bytes: Uint8Array): Uint8Array | null {
  const { purifier: p, window: win } = purify();
  const body = p.sanitize(new TextDecoder().decode(bytes), {
    USE_PROFILES: { svg: true, svgFilters: true },
    ADD_TAGS: ["style", "use"],
    ADD_ATTR: ["href", "xlink:href"],
    FORBID_TAGS: ["script", "foreignObject", "animate", "set", "animateMotion", "animateTransform", "image", "iframe", "embed", "object"],
    ALLOW_DATA_ATTR: false,
    RETURN_DOM: true,
  });
  const svg = (body as unknown as Element).querySelector("svg");
  if (!svg) return null;
  const out = new win.XMLSerializer().serializeToString(svg);
  return new TextEncoder().encode(out);
}
