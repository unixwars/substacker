import { outboundUrl } from "substacker-core";
import { contentBase } from "./config.js";
import type { ShellConfig } from "./config.js";
import { ListView } from "./ListView.js";
import { PostView } from "./PostView.js";
import { listHref, useRoute } from "./route.js";

export function App({ config }: { config: ShellConfig }) {
  const route = useRoute();
  const base = contentBase(config, window.location.href);
  return (
    <div className="shell">
      <header className="shell-header">
        <a className="shell-title" href={listHref()}>{config.feedName}</a>
        {config.subscribeUrl ? (
          <a className="shell-subscribe" href={outboundUrl(config.subscribeUrl, { utmSource: config.utmSource })} target="_blank" rel="noopener noreferrer">
            Subscribe
          </a>
        ) : null}
      </header>
      <main>
        {route.name === "post" ? (
          <PostView base={base} slug={route.slug} config={config} />
        ) : (
          <ListView base={base} query={route.q} />
        )}
      </main>
    </div>
  );
}
