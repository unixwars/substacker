import createDOMPurify from "dompurify";
import type { DOMPurify, WindowLike } from "dompurify";
import { SANITIZE_POLICY, allowedUriPattern } from "./sanitize-policy.js";
import type { SanitizePolicy } from "./sanitize-policy.js";

/**
 * Supplies the DOM window DOMPurify works in: `() => window` in a browser,
 * `() => new JSDOM("").window` in Node.
 */
export type DomParser = () => WindowLike;

const instances = new WeakMap<object, DOMPurify>();

function purifierFor(parse: DomParser): DOMPurify {
  const win = parse();
  let purify = instances.get(win);
  if (!purify) {
    purify = createDOMPurify(win);
    purify.addHook("afterSanitizeAttributes", (node) => {
      if (node.nodeName === "A" && node.hasAttribute("href")) {
        node.setAttribute("rel", "noopener noreferrer");
      }
    });
    instances.set(win, purify);
  }
  return purify;
}

/** Sanitize an HTML fragment with the shared policy. Returns an HTML string. */
export function sanitizeHtml(html: string, parse: DomParser, policy: SanitizePolicy = SANITIZE_POLICY): string {
  return purifierFor(parse).sanitize(html, {
    ALLOWED_TAGS: [...policy.allowedTags],
    ALLOWED_ATTR: [...policy.allowedAttributes],
    ALLOWED_URI_REGEXP: allowedUriPattern(policy),
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    RETURN_DOM: false,
    RETURN_DOM_FRAGMENT: false,
  });
}
