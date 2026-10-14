// Offline support: app shell cached, data network-first.
const VERSION = "pullback-__BUILD__";
const SHELL = [
  "./", "index.html", "app.css", "app.js", "manifest.webmanifest",
  "vendor/lightweight-charts.standalone.production.js",
  "icons/icon-192.png", "icons/icon-512.png", "icons/favicon.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  const isData = url.pathname.includes("/data/") || url.pathname.endsWith("config.json");
  if (isData) {
    // network first, fall back to the last copy we saw
    const key = url.origin + url.pathname;
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(key, copy)); }
          return res;
        })
        .catch(() => caches.match(key))
    );
  } else {
    e.respondWith(
      caches.match(e.request).then((hit) => {
        const net = fetch(e.request).then((res) => {
          if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); }
          return res;
        }).catch(() => hit);
        return hit || net;
      })
    );
  }
});
