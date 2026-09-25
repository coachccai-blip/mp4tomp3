/* Cache hors-ligne : après un premier chargement, l'application fonctionne sans connexion. */
const CACHE = "studio-audio-v2";
const ASSETS = [
  "./",
  "index.html",
  "js/app.js",
  "vendor/ffmpeg.js",
  "vendor/814.ffmpeg.js",
  "vendor/ffmpeg-util.js",
  "vendor/ffmpeg-core.js",
  "vendor/ffmpeg-core.wasm",
  "vendor/jszip.min.js",
  "vendor/models/bd.rnnn",
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* Réseau d'abord pour la page (mises à jour), cache d'abord pour les ressources. */
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  const isPage = e.request.mode === "navigate" || url.pathname.endsWith("index.html");
  if (isPage) {
    e.respondWith(
      fetch(e.request)
        .then(resp => {
          const copy = resp.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
          return resp;
        })
        .catch(() => caches.match(e.request).then(r => r || caches.match("index.html")))
    );
  } else {
    e.respondWith(
      caches.match(e.request).then(cached => cached || fetch(e.request).then(resp => {
        const copy = resp.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return resp;
      }))
    );
  }
});
