/**
 * Service worker for circle. and crew. (served by the host router at /sw.js on those hosts only).
 * Goal: a Crew member can open the installed app with no signal and still see the app, show the offline QR and log
 * leads (they queue on the phone and send later). It is deliberately small and careful:
 *   - never touches /api/ or any non-GET request (money and sign-in always go to the network);
 *   - pages: network first, fall back to the last copy;
 *   - css / js / images / fonts: serve the saved copy at once, refresh it quietly in the background.
 * Change VERSION to retire every saved copy at once.
 */
const VERSION = 'nexta-growth-v4';
const SHELL = ['/', '/css/growth.css', '/js/growth-hosts.js', '/js/growth-ui.js', '/js/growth-qr.js', '/js/growth-kit.js', '/js/growth.js',
    '/assets/growth-brand/svg/lockup-circle.svg', '/assets/growth-brand/svg/lockup-crew.svg'];

self.addEventListener('install', (event) => {
    event.waitUntil(caches.open(VERSION).then((cache) => Promise.all(SHELL.map((u) => cache.add(u).catch(() => null)))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (event) => {
    event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('nexta-growth-') && k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

const isStatic = (url) => /^\/(css|js|assets|webfonts|fonts|img|images)\//.test(url.pathname) || /\.(css|js|png|jpe?g|svg|webp|ico|woff2?)$/i.test(url.pathname);

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;
    const url = new URL(req.url);
    if (url.origin !== self.location.origin || url.pathname.startsWith('/api/') || url.pathname === '/sw.js') return;

    if (req.mode === 'navigate') {
        event.respondWith(
            fetch(req).then((res) => {
                if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
                return res;
            }).catch(async () => (await caches.match(req)) || (await caches.match('/')) || new Response('You are offline.', { status: 503, headers: { 'Content-Type': 'text/plain' } }))
        );
        return;
    }
    if (isStatic(url)) {
        event.respondWith(caches.open(VERSION).then(async (cache) => {
            const hit = await cache.match(req);
            const refresh = fetch(req).then((res) => { if (res.ok) cache.put(req, res.clone()); return res; }).catch(() => null);
            return hit || (await refresh) || new Response('', { status: 504 });
        }));
    }
});
