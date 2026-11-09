/**
 * The `<meta name="robots" content="noindex">` tag the build adds to index.html unless
 * `noindex` is turned off in the configuration. The reader is a second public copy of
 * posts that live on Substack, so it asks search engines not to index it. The tag sits in
 * the static HTML, so it needs no JavaScript to be seen. (GitHub Pages cannot send an
 * `X-Robots-Tag` header, so the JSON and image files cannot carry the same request.)
 */
export function robotsMeta(noindex: boolean) {
  return noindex ? { tag: "meta" as const, attrs: { name: "robots", content: "noindex" }, injectTo: "head" as const } : undefined;
}
