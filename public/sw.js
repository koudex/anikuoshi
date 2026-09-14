/* ══════════════════════════════════════════════════════════════
   AniKuoshi — sw.js (service worker)
   - Precache: shell assets + offline page
   - Static (css/js/img/fonts): cache-first
   - Pages: network-first with offline fallback
   - htmx fragments (/fragments/*): network-first, stale fallback
   - API (/api/*): network-only (always fresh, never cached)
   ══════════════════════════════════════════════════════════════ */
const VERSION = "anikuoshi-v1";
const STATIC_CACHE = `${VERSION}-static`;
const PAGE_CACHE = `${VERSION}-pages`;
const FRAG_CACHE = `${VERSION}-frag`;

const PRECACHE = [
  "/css/anikuoshi.css",
  "/js/app.js",
  "/js/player.js",
  "/js/settings.js",
  "/js/docs.js",
  "/js/page-anime.js",
  "/htmx.min.js",
  "/manifest.webmanifest",
  "/icons/favicon.svg",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/offline",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

const isStatic = (url) =>
  url.pathname.startsWith("/css/") ||
  url.pathname.startsWith("/js/") ||
  url.pathname.startsWith("/icons/") ||
  url.pathname === "/htmx.min.js" ||
  url.pathname === "/manifest.webmanifest";

const isFragment = (url) => url.pathname.startsWith("/fragments/");

async function networkFirst(request, cacheName, fallbackUrl) {
  const cache = await caches.open(cacheName);
  try {
    const fresh = await fetch(request);
    if (fresh && fresh.ok) cache.put(request, fresh.clone());
    return fresh;
  } catch (err) {
    const cached = await cache.match(request, { ignoreSearch: request.mode === "navigate" });
    if (cached) return cached;
    if (fallbackUrl) {
      const fallback = await cache.match(fallbackUrl);
      if (fallback) return fallback;
    }
    return new Response("<h1>Offline</h1><p>This content isn't cached yet. Reconnect and try again.</p>",
      { status: 503, headers: { "Content-Type": "text/html" } });
  }
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) {
    // refresh in background
    fetch(request).then((res) => { if (res && res.ok) cache.put(request, res.clone()); }).catch(() => {});
    return cached;
  }
  const fresh = await fetch(request);
  if (fresh && fresh.ok) cache.put(request, fresh.clone());
  return fresh;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;      // let embeds/CDNs pass through
  if (url.pathname.startsWith("/api/")) return;         // API: always network
  if (url.pathname.startsWith("/docs")) return;         // playground: always live

  if (isStatic(url)) {
    event.respondWith(cacheFirst(request, STATIC_CACHE));
    return;
  }
  if (isFragment(url)) {
    event.respondWith(networkFirst(request, FRAG_CACHE));
    return;
  }
  if (request.mode === "navigate" || (request.headers.get("accept") || "").includes("text/html")) {
    event.respondWith(networkFirst(request, PAGE_CACHE, "/offline"));
    return;
  }
});
