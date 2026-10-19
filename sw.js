// Taproot service worker. A home-screen install (and the Play Store wrapper) needs one with a fetch handler; this
// one stays out of the way. Same-origin GETs go to the network first, and the last good copy answers when the
// network does not, so the shell opens offline. Nothing cross-origin is touched: wallet RPCs, the price feed reads
// and the CDN scripts behave exactly as without a worker. Bump VERSION to drop every old cache on the next load.
const VERSION = "taproot-sw-2026-10-19";
const SHELL = ["/", "/index.html", "/seal.html", "/seal-core.mjs", "/manifest.webmanifest", "/assets_base/icon_192.png", "/assets_base/icon_512.png"];

self.addEventListener("install", (e) => {
  // A shell file that fails to fetch is skipped, not fatal: an install must never hang on one path.
  e.waitUntil(caches.open(VERSION).then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => {})))).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); }
        return res;
      })
      .catch(() => caches.match(e.request).then((hit) => hit || (e.request.mode === "navigate" ? caches.match("/index.html") : Response.error()))),
  );
});
