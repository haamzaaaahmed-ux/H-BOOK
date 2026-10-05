const CACHE='booklens-v4';
const ASSETS=['./','./index.html','./styles.css?v=4','./app.js?v=4','./manifest.webmanifest','./icon-192.png','./icon-512.png','./vendor/xlsx.full.min.js'];
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting())));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',e=>{if(e.request.method!=='GET')return;e.respondWith(caches.match(e.request).then(cached=>cached||fetch(e.request).then(response=>{if(response.ok&&new URL(e.request.url).origin===self.location.origin)caches.open(CACHE).then(c=>c.put(e.request,response.clone()));return response;})))});
