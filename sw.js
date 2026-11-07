/* PrePro offline support. Network first, so updates arrive straight away; the saved copy is used when offline. */
const CACHE = 'prepro-v20';
const CORE = ['./', 'index.html', 'legal.html', 'security.html', 'style.css', 'storage.js', 'app.js', 'midi.js', 'editpro.js', 'prepro.js', 'creative.js', 'cliptools.js', 'license.js', 'workflow.js', 'micfix.js', 'stage.js', 'audition.js', 'pwa.js', 'capture-worklet.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)).catch(() => {})); self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const r = e.request;
  if (r.method !== 'GET') return;
  const u = new URL(r.url);
  const same = u.origin === location.origin;
  const fonts = /fonts\.(googleapis|gstatic)\.com$/.test(u.hostname);
  if (!same && !fonts) return; // licence checks, AI providers and checkout always go straight to the network
  if (fonts) { e.respondWith(caches.match(r).then(hit => hit || fetch(r).then(res => { const cp = res.clone(); caches.open(CACHE).then(c => c.put(r, cp)); return res; }))); return; }
  e.respondWith(fetch(r).then(res => { if (res.ok) { const cp = res.clone(); caches.open(CACHE).then(c => c.put(r, cp)); } return res; })
    .catch(() => caches.match(r, { ignoreSearch: true }).then(hit => hit || (r.mode === 'navigate' ? caches.match('index.html') : Response.error()))));
});
