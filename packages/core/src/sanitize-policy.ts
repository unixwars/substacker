/**
 * What survives sanitizing, as data. One policy is shared by the scraper (Node,
 * through jsdom) and every reader (the browser), so a post is cleaned the same
 * way on both sides.
 */
export interface SanitizePolicy {
  readonly allowedTags: readonly string[];
  readonly allowedAttributes: readonly string[];
  readonly allowedSchemes: readonly string[];
}

export const SANITIZE_POLICY: SanitizePolicy = {
  allowedTags: [
    "p", "br", "hr", "div", "span",
    "h1", "h2", "h3", "h4", "h5", "h6",
    "a", "img", "figure", "figcaption",
    "ul", "ol", "li", "dl", "dt", "dd",
    "blockquote", "pre", "code",
    "em", "strong", "b", "i", "u", "s", "del", "ins", "mark", "sub", "sup", "small",
    "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption",
    "details", "summary",
  ],
  allowedAttributes: ["href", "src", "alt", "title", "width", "height", "colspan", "rowspan", "rel"],
  allowedSchemes: ["http", "https", "mailto"],
};

/** URI pattern for the policy's schemes. Relative URLs (no scheme) are allowed. */
export function allowedUriPattern(policy: SanitizePolicy = SANITIZE_POLICY): RegExp {
  const schemes = policy.allowedSchemes.map((s) => s.replace(/[^a-z0-9+.-]/gi, "")).join("|");
  return new RegExp(`^(?:(?:${schemes}):|[^a-z]|[a-z+.\\-]+(?:[^a-z+.\\-:]|$))`, "i");
}
