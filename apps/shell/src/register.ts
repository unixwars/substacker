import type { ShellConfig } from "./config.js";
import { DEFAULT_CAP_BYTES } from "./offline-shared.js";

/** Register the worker generated at build time. Production builds only. */
export function registerServiceWorker(config: ShellConfig): void {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
  const cap = config.offlineCapBytes ?? DEFAULT_CAP_BYTES;
  const url = new URL(`${import.meta.env.BASE_URL}sw.js`, document.baseURI);
  url.searchParams.set("cap", String(cap));
  navigator.serviceWorker.register(url).catch((e: unknown) => console.warn("service worker not registered", e));
}
