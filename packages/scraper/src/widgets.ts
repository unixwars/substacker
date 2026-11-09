import { JSDOM } from "jsdom";

export type CtaKind = "subscribe" | "comments" | "share";

/** Classify a Substack call-to-action link by its address, or null for any other link. */
export function ctaKind(href: string): CtaKind | null {
  let url: URL;
  try {
    url = new URL(href, "https://example.invalid");
  } catch {
    return null;
  }
  const path = url.pathname.replace(/\/+$/, "");
  if (url.searchParams.get("action") === "share") return "share";
  if (path.endsWith("/comments")) return "comments";
  if (path === "/subscribe" || path.endsWith("/subscribe")) return "subscribe";
  return null;
}

/** First address of a `srcset` value (the candidate list's first URL). */
function firstSrcsetUrl(srcset: string): string | null {
  const first = srcset.split(",")[0]?.trim().split(/\s+/)[0];
  return first ? first : null;
}

/**
 * The one address kept for a `<picture>`: the fallback `<img src>`, else the last
 * `<source>` candidate (the widest the feed offers).
 */
export function pictureSource(picture: Element): string | null {
  const img = picture.querySelector("img");
  const src = img?.getAttribute("src");
  if (src) return src;
  const sources = [...picture.querySelectorAll("source[srcset]")];
  for (const source of sources.reverse()) {
    const url = firstSrcsetUrl(source.getAttribute("srcset") ?? "");
    if (url) return url;
  }
  return null;
}

function isEmpty(el: Element): boolean {
  return (el.textContent ?? "").trim() === "" && el.querySelector("img,picture,a,iframe,hr,table") === null;
}

/**
 * Prepare a post body: drop Substack's widgets and presentation, leaving plain
 * semantic markup for the sanitizer. Pure and deterministic.
 */
export function stripWidgets(html: string): string {
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`);
  const doc = dom.window.document;

  // Call-to-action buttons: subscribe, comments and share are offered by the
  // readers themselves; any other button link stays as a plain link.
  for (const wrapper of [...doc.querySelectorAll("p.button-wrapper")]) {
    const link = wrapper.querySelector("a[href]");
    const href = link?.getAttribute("href") ?? "";
    if (!link || ctaKind(href) !== null) {
      wrapper.remove();
    } else {
      const p = doc.createElement("p");
      const a = doc.createElement("a");
      a.setAttribute("href", href);
      a.textContent = (link.textContent ?? "").trim() || href;
      p.append(a);
      wrapper.replaceWith(p);
    }
  }

  // Buttons and icons.
  for (const el of doc.querySelectorAll("button, svg")) el.remove();

  // A picture becomes one image.
  for (const picture of [...doc.querySelectorAll("picture")]) {
    const src = pictureSource(picture);
    if (!src) {
      picture.remove();
      continue;
    }
    const old = picture.querySelector("img");
    const img = doc.createElement("img");
    img.setAttribute("src", src);
    for (const name of ["alt", "width", "height"]) {
      const value = old?.getAttribute(name);
      if (value !== null && value !== undefined) img.setAttribute(name, value);
    }
    picture.replaceWith(img);
  }

  // An image wrapped in a link to its own enlarged copy: keep the image only.
  for (const a of [...doc.querySelectorAll("a.image-link")]) {
    a.replaceWith(...a.childNodes);
  }

  // Embeds become a link to their source.
  for (const frame of [...doc.querySelectorAll("iframe, embed, object")]) {
    const src = frame.getAttribute("src") ?? frame.getAttribute("data");
    if (src && /^https?:/i.test(src)) {
      const p = doc.createElement("p");
      const a = doc.createElement("a");
      a.setAttribute("href", src);
      a.textContent = src;
      p.append(a);
      (frame.closest(".youtube-wrap, .tweet, .embedded-post-wrap, .embed") ?? frame).replaceWith(p);
    } else {
      frame.remove();
    }
  }

  // Presentation: classes, data attributes, responsive image lists.
  for (const el of doc.body.querySelectorAll("*")) {
    for (const name of el.getAttributeNames()) {
      if (name === "class" || name.startsWith("data-") || name === "srcset" || name === "sizes" || name === "loading") {
        el.removeAttribute(name);
      }
    }
  }

  // Wrappers emptied by the removals above.
  let removed = true;
  while (removed) {
    removed = false;
    for (const el of [...doc.body.querySelectorAll("div, span")]) {
      if (isEmpty(el)) {
        el.remove();
        removed = true;
      }
    }
  }

  return doc.body.innerHTML;
}
