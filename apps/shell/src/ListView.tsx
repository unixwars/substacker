import { useFeedIndex, useSearch } from "substacker-core/react";
import { listHref, postHref } from "./route.js";
import { postUrl, useOfflineKeys } from "./useOffline.js";
import type { Entry } from "substacker-core";

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}

function Entries({ entries, base }: { entries: Entry[]; base: string }) {
  const offline = useOfflineKeys(base);
  return (
    <ul className="entries">
      {entries.map((e) => (
        <li key={e.slug} className="entry">
          <a href={postHref(e.slug)}>
            <span className="entry-title">{e.title}</span>
            <time className="entry-date" dateTime={e.date}>{formatDate(e.date)}</time>
            {offline.has(postUrl(base, e.slug)) ? <span className="offline-marker" data-offline="true">Available offline</span> : null}
            {e.excerpt ? <span className="entry-excerpt">{e.excerpt}</span> : null}
          </a>
        </li>
      ))}
    </ul>
  );
}

export function ListView({ base, query }: { base: string; query: string }) {
  const index = useFeedIndex(base);
  const search = useSearch(base, query);

  const form = (
    <form className="search" role="search" onSubmit={(ev) => ev.preventDefault()}>
      <input
        type="search"
        aria-label="Search posts"
        placeholder="Search"
        value={query}
        onChange={(ev) => {
          window.location.hash = listHref(ev.target.value);
        }}
      />
    </form>
  );

  if (index.status === "loading") return <p role="status">Loading</p>;
  if (index.status === "unsupported") return <p role="alert">This content needs a newer version of the reader.</p>;
  if (index.status === "error") return <p role="alert">Could not load the posts ({index.reason}).</p>;
  if (index.index.posts.length === 0) return <p className="empty">No posts yet.</p>;

  let body;
  if (query.trim() === "") body = <Entries entries={index.index.posts} base={base} />;
  else if (search.status === "loading") body = <p role="status">Searching</p>;
  else if (search.status === "ready") {
    body = search.results.length === 0 ? <p className="empty">No posts match.</p> : <Entries entries={search.results} base={base} />;
  } else body = <p role="alert">Search is not available.</p>;

  return (
    <>
      {form}
      {body}
    </>
  );
}
