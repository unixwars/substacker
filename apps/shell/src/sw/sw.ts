/// <reference lib="webworker" />
import {
  cachePrefix, capFromSearch, classify, contentCacheName, databaseName, isShellNavigation, scopePath, shellCacheName,
} from "../offline-shared.js";
import { planEviction } from "./eviction.js";

declare const self: ServiceWorkerGlobalScope;
declare const __PRECACHE__: string[];
declare const __BUILD_ID__: string;

const scope = scopePath(self.registration.scope);
const prefix = cachePrefix(scope);
const shellCache = shellCacheName(prefix, __BUILD_ID__);
const contentCache = contentCacheName(prefix);
const cap = capFromSearch(self.location.search);

// Last-opened times live in IndexedDB: the Cache API stores no access times.
interface Meta { key: string; bytes: number; lastOpened: number }

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(databaseName(prefix), 1);
    req.onupgradeneeded = () => req.result.createObjectStore("entries", { keyPath: "key" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = run(db.transaction("entries", mode).objectStore("entries"));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

const allMeta = () => withStore<Meta[]>("readonly", (s) => s.getAll());
const putMeta = (m: Meta) => withStore("readwrite", (s) => s.put(m));
const deleteMeta = (key: string) => withStore("readwrite", (s) => s.delete(key));

async function latestOpened(): Promise<number> {
  return (await allMeta()).reduce((max, m) => Math.max(max, m.lastOpened), 0);
}

async function enforceCap(): Promise<void> {
  const entries = await allMeta();
  const cache = await caches.open(contentCache);
  for (const key of planEviction(entries, cap)) {
    await cache.delete(key);
    await deleteMeta(key);
  }
}

/**
 * IndexedDB only keeps the eviction order. It can fail (private modes, a full disk, a blocked
 * upgrade) and must never break a fetch that works, so every use of it goes through here.
 */
async function bookkeeping<T>(run: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await run();
  } catch {
    return fallback;
  }
}

async function store(request: Request, response: Response, lastOpened: number): Promise<void> {
  const cache = await caches.open(contentCache);
  const bytes = (await response.clone().blob()).size;
  await cache.put(request, response);
  await bookkeeping(async () => {
    await putMeta({ key: request.url, bytes, lastOpened });
    await enforceCap();
  }, undefined);
}

async function touch(url: string, lastOpened: number): Promise<void> {
  await bookkeeping(async () => {
    const existing = (await allMeta()).find((m) => m.key === url);
    if (existing) await putMeta({ ...existing, lastOpened });
  }, undefined);
}

async function staleWhileRevalidate(event: FetchEvent): Promise<Response> {
  const cache = await caches.open(contentCache);
  const cached = await cache.match(event.request);
  const refresh = fetch(event.request).then(async (res) => {
    if (res.ok) await cache.put(event.request, res.clone());
    return res;
  });
  if (cached) {
    event.waitUntil(refresh.catch(() => undefined));
    return cached;
  }
  return refresh;
}

// A post is network first, so edits show up; it is kept when opened and served from the
// cache when the network is gone or the server answers 5xx.
async function post(event: FetchEvent): Promise<Response> {
  const when = Math.max(Date.now(), (await bookkeeping(latestOpened, 0)) + 1);
  const fromCache = async () => {
    const cached = await (await caches.open(contentCache)).match(event.request);
    if (cached) event.waitUntil(touch(event.request.url, when));
    return cached;
  };
  let res: Response;
  try {
    res = await fetch(event.request);
  } catch {
    return (await fromCache()) ?? Response.error();
  }
  if (res.ok) event.waitUntil(store(event.request, res.clone(), when));
  else if (res.status >= 500) return (await fromCache()) ?? res;
  return res;
}

// An image is cache first. It belongs to the post being read, so it takes that post's time.
async function image(event: FetchEvent): Promise<Response> {
  const cache = await caches.open(contentCache);
  const cached = await cache.match(event.request);
  const when = await bookkeeping(latestOpened, 0);
  if (cached) {
    event.waitUntil(touch(event.request.url, when));
    return cached;
  }
  const res = await fetch(event.request);
  if (res.ok) event.waitUntil(store(event.request, res.clone(), when));
  return res;
}

async function shell(event: FetchEvent): Promise<Response> {
  const cache = await caches.open(shellCache);
  const navigating = event.request.mode === "navigate";
  const target = navigating ? new Request(new URL("index.html", self.registration.scope)) : event.request;
  const cached = await cache.match(target, { ignoreSearch: true });
  return cached ?? fetch(event.request);
}

/**
 * Keep `config.json` and the content index from the first visit. The page loads them before
 * this worker controls it, so they never pass through the fetch handler; without a copy, a
 * first visit followed by going offline would find nothing to start from.
 */
async function precacheContent(): Promise<void> {
  const cache = await caches.open(contentCache);
  const configUrl = new URL("config.json", self.registration.scope).href;
  const configRes = await fetch(configUrl, { cache: "reload" });
  if (!configRes.ok) return;
  await cache.put(configUrl, configRes.clone());
  const { contentUrl } = (await configRes.json()) as { contentUrl?: unknown };
  if (typeof contentUrl !== "string") return;
  const base = new URL(contentUrl.endsWith("/") ? contentUrl : `${contentUrl}/`, self.registration.scope);
  const indexUrl = new URL("index.json", base);
  // The fetch handler only serves this origin and scope, so only those are worth keeping.
  if (indexUrl.origin !== self.location.origin || !indexUrl.pathname.startsWith(scope)) return;
  const indexRes = await fetch(indexUrl, { cache: "reload" });
  if (indexRes.ok) await cache.put(indexUrl.href, indexRes);
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(shellCache);
      await cache.addAll(__PRECACHE__.map((p) => new URL(p, self.registration.scope).href));
      await precacheContent().catch(() => undefined);
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Only this shell's own, superseded caches. Another shell on the same origin keeps its own.
      for (const name of await caches.keys()) {
        if (name.startsWith(prefix) && name !== shellCache && name !== contentCache) await caches.delete(name);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(scope)) return;
  const kind = classify(url.pathname, scope);
  if (kind === "revalidate") event.respondWith(staleWhileRevalidate(event));
  else if (kind === "post") event.respondWith(post(event));
  else if (kind === "image") event.respondWith(image(event));
  else if (
    (request.mode === "navigate" && isShellNavigation(url.pathname, scope)) ||
    url.pathname.startsWith(`${scope}assets/`) ||
    url.pathname === `${scope}manifest.webmanifest`
  ) {
    event.respondWith(shell(event));
  }
});
