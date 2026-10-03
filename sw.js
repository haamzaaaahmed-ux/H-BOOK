const CACHE = 'booklens-v2';
const ASSETS = [
  './', './index.html', './styles.css', './app.js', './manifest.webmanifest', './icon-192.png', './icon-512.png',
  './vendor/tesseract.min.js', './vendor/xlsx.full.min.js', './vendor/pdf.min.mjs', './vendor/pdf.worker.min.mjs',
  './ocr/worker.min.js', './ocr/core/tesseract-core-lstm.wasm', './ocr/core/tesseract-core-lstm.wasm.js',
  './ocr/lang/ara.traineddata', './ocr/lang/eng.traineddata'
];
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => {
    if (response.ok && new URL(event.request.url).origin === self.location.origin) {
      const copy = response.clone(); caches.open(CACHE).then((cache) => cache.put(event.request, copy));
    }
    return response;
  })));
});
