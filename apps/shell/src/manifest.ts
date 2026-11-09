/** Neutral name used when no configuration is given (development). */
export const DEFAULT_APP_NAME = "Reader";

/** The icon's background colour, sampled by scripts/make-icons.mjs. */
export const ICON_THEME_COLOUR = "#fd5c0c";

const SHORT_NAME_LIMIT = 12;

/** A name that fits under an app icon: the whole name, else its first word, else a cut. */
export function shortNameOf(name: string): string {
  if (name.length <= SHORT_NAME_LIMIT) return name;
  const first = name.split(/\s+/)[0] ?? name;
  return (first.length <= SHORT_NAME_LIMIT ? first : first.slice(0, SHORT_NAME_LIMIT)).trim();
}

export interface WebManifest {
  name: string;
  short_name: string;
  start_url: string;
  scope: string;
  display: "standalone";
  background_color: string;
  theme_color: string;
  icons: { src: string; sizes: string; type: string; purpose: "any" | "maskable" }[];
}

/** The web app manifest for a deployment. Every path is relative, so any base path works. */
export function manifestFor(config: { feedName: string } | undefined): WebManifest {
  const name = config?.feedName.trim() || DEFAULT_APP_NAME;
  return {
    name,
    short_name: shortNameOf(name),
    start_url: ".",
    scope: ".",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: ICON_THEME_COLOUR,
    icons: [
      { src: "icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
      { src: "icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
    ],
  };
}
