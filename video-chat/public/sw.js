// Caches the app shell so the installed app opens instantly. Live data (API,
// WebSocket signaling, payments, verification) always goes to the network.
const CACHE = "shell-v8";
const SHELL = [
  "/",
  "/index.html",
  "/style.css",
  "/app.js",
  "/moderation.js",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== location.origin) return;
  if (/^\/(api|ws|dev|admin)(\/|$)/.test(url.pathname)) return;

  // Network first so a deploy shows up right away; cache only when offline.
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(event.request).then((hit) => hit ?? caches.match("/index.html"))),
  );
});
