import { useEffect, useState } from "react";

export type Route = { name: "list"; q: string } | { name: "post"; slug: string };

/** `#/` list, `#/?q=text` search, `#/p/<slug>` post. */
export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#/, "");
  const [path = "", query = ""] = raw.split("?", 2);
  const post = /^\/p\/(.+)$/.exec(path);
  if (post?.[1]) {
    try {
      return { name: "post", slug: decodeURIComponent(post[1]) };
    } catch {
      return { name: "list", q: "" };
    }
  }
  return { name: "list", q: new URLSearchParams(query).get("q") ?? "" };
}

export const postHref = (slug: string) => `#/p/${encodeURIComponent(slug)}`;
export const listHref = (q = "") => (q ? `#/?q=${encodeURIComponent(q)}` : "#/");

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseHash(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}
