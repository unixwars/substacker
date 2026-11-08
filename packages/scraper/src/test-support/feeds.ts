import { readFileSync } from "node:fs";

export const fixtureFeed = readFileSync(new URL("../../test/fixtures/feed.xml", import.meta.url), "utf8");

export interface ItemSpec {
  title: string;
  link: string;
  pubDate?: string;
  description?: string;
  body?: string;
  enclosure?: string;
}

export function itemXml(spec: ItemSpec): string {
  const enc = spec.enclosure ? `<enclosure url="${spec.enclosure}" length="0" type="image/jpeg"/>` : "";
  return `<item>
      <title><![CDATA[${spec.title}]]></title>
      <description><![CDATA[${spec.description ?? ""}]]></description>
      <link>${spec.link}</link>
      <guid isPermaLink="false">${spec.link}</guid>
      <pubDate>${spec.pubDate ?? "Mon, 02 Mar 2026 10:00:00 GMT"}</pubDate>
      ${enc}
      <content:encoded><![CDATA[${spec.body ?? "<p>Body.</p>"}]]></content:encoded>
    </item>`;
}

export function feedXml(items: ItemSpec[], title = "Example Newsletter"): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:content="http://purl.org/rss/1.0/modules/content/" version="2.0">
  <channel>
    <title><![CDATA[${title}]]></title>
    <link>https://example.substack.com</link>
${items.map(itemXml).join("\n")}
  </channel>
</rss>
`;
}
