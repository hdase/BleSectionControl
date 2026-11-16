// Cache der App-Dateien, damit die App auch ohne Mobilfunk im Feld startet.
importScripts('version.js');
const CACHE = 'blesc-' + APP_VERSION;
const FILES = ['./', 'index.html', 'app.js', 'version.js', 'style.css', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
// Erst Netz (neue Version), bei Fehler Cache
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  if (new URL(e.request.url).pathname.includes('/firmware/')) return;  // Firmware nie aus dem Cache
  e.respondWith(fetch(e.request, { cache: 'no-cache' }).then(r => {
    const copy = r.clone();
    caches.open(CACHE).then(c => c.put(e.request, copy));
    return r;
  }).catch(() => caches.match(e.request)));
});
