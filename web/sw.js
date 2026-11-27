// App shell cache. Data (Supabase) is never cached here.
const CACHE = "syssport-v2";
const SHELL = ["./", "index.html", "styles.css", "fonts.css", "app.js", "config.js", "vendor/supabase.js",
  "fonts/patua-one-latin-400-normal.woff2", "fonts/outfit-latin-300-normal.woff2", "fonts/outfit-latin-400-normal.woff2",
  "fonts/outfit-latin-600-normal.woff2", "fonts/outfit-latin-800-normal.woff2", "icons/icon-192.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin) return;
  // Network first so updates arrive immediately; cache as offline fallback.
  e.respondWith(fetch(e.request).then(r => {
    const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return r;
  }).catch(() => caches.match(e.request).then(r => r || caches.match("index.html"))));
});
