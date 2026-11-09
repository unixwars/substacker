import { useMemo } from "react";
import { dockLinks, outboundUrl, resolveAssets } from "substacker-core";
import { sanitizeHtml } from "substacker-core/dom";
import { usePost } from "substacker-core/react";
import type { ShellConfig } from "./config.js";
import { listHref, postHref } from "./route.js";
import { postUrl, useOfflineKeys } from "./useOffline.js";

const KIND_LABEL = { comment: "Comments", share: "Share" } as const;

function errorText(reason: "network" | "malformed" | "not-found"): string {
  if (reason === "not-found") return "Post not found.";
  if (reason === "network" && !navigator.onLine) return "This post is not available offline.";
  return `Could not load the post (${reason}).`;
}

function Body({ html, base }: { html: string; base: string }) {
  // Sanitized again at render time: the content branch is not trusted.
  const safe = useMemo(() => resolveAssets(sanitizeHtml(html, () => window), base), [html, base]);
  return <div className="post-body" dangerouslySetInnerHTML={{ __html: safe }} />;
}

export function PostView({ base, slug, config }: { base: string; slug: string; config: ShellConfig }) {
  const state = usePost(base, slug);
  const offline = useOfflineKeys(`${slug}:${state.status}`);
  if (state.status === "loading") return <p role="status">Loading</p>;
  if (state.status === "unsupported") return <p role="alert">This content needs a newer version of the reader.</p>;
  if (state.status === "error") {
    return (
      <div role="alert">
        <p>{errorText(state.reason)}</p>
        <a href={listHref()}>All posts</a>
      </div>
    );
  }
  const { post, previous, next } = state;
  const dock = dockLinks(post, config.actions, config.utmSource);
  return (
    <article className="post">
      <p><a href={listHref()}>All posts</a></p>
      <h1>{post.title}</h1>
      {offline.has(postUrl(base, post.slug)) ? <p className="offline-marker" data-offline="true">Available offline</p> : null}
      <time dateTime={post.date}>{new Date(post.date).toLocaleDateString("en", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" })}</time>
      <Body html={post.html} base={base} />
      <footer className="post-footer">
        <a className="read-on-source" href={outboundUrl(post.sourceUrl, { utmSource: config.utmSource })} target="_blank" rel="noopener noreferrer">
          Read on Substack
        </a>
        {dock.length > 0 ? (
          <nav className="dock" aria-label="Post actions">
            {dock.map((l) => (
              <a key={l.kind} data-kind={l.kind} href={l.href} target="_blank" rel="noopener noreferrer">{KIND_LABEL[l.kind]}</a>
            ))}
          </nav>
        ) : null}
        <nav className="pager" aria-label="Posts">
          {previous ? <a rel="prev" href={postHref(previous.slug)}>Newer: {previous.title}</a> : <span />}
          {next ? <a rel="next" href={postHref(next.slug)}>Older: {next.title}</a> : <span />}
        </nav>
      </footer>
    </article>
  );
}
