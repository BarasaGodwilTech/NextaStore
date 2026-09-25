#!/usr/bin/env node
'use strict';
/*
 * Real-browser check of the Web Push half of service-worker.js.
 *
 *   npm i --no-save playwright && npx playwright install chromium   (once)
 *   npm run test:push-browser
 *
 * It serves the repo root on a random localhost port, registers the REAL
 * service worker in Chromium, and injects push messages with the DevTools
 * command ServiceWorker.deliverPushMessage — the same "Push" button as
 * Application > Service Workers in DevTools. The worker's real `push` handler
 * runs and the notifications it creates are read back with
 * registration.getNotifications().
 *
 * What this covers: the push handler in a real engine (payload parsing, icon
 * and badge URLs, per-conversation replacement, orders stacking, hostile
 * links), cache cleanup on activation, offline fallback still working, and the
 * "a push arrived" message to open pages.
 *
 * What it can NOT cover, in any automation tool:
 *   - tapping a notification (routing is tested in scripts/push-sw-test.js),
 *   - real delivery from a push service to a real phone. Subscribing needs
 *     Google/Apple/Mozilla push servers, so use a device over HTTPS for that.
 *
 * Uses Chromium's "new headless" (channel: 'chromium'): the default headless
 * shell always reports notification permission as denied.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

// Read from the real file rather than hardcoding 'v7' — otherwise this test
// silently starts asserting the wrong thing the next time CACHE_VERSION is
// bumped (as happened going from v7 to v8 for the presence frontend).
const CURRENT_CACHE_VERSION_NUM = Number((fs.readFileSync(path.join(ROOT, 'service-worker.js'), 'utf8').match(/CACHE_VERSION = 'v(\d+)'/) || [])[1] || 7);
const CURRENT_CACHE_NAME = `nextastore-cache-v${CURRENT_CACHE_VERSION_NUM}`;
const PREVIOUS_CACHE_NAME = `nextastore-cache-v${CURRENT_CACHE_VERSION_NUM - 1}`;

function loadPlaywright() {
    try { return require('playwright'); } catch (e) { /* fall through */ }
    try { return require(path.join(require('child_process').execSync('npm root -g').toString().trim(), 'playwright')); } catch (e) { /* fall through */ }
    console.error('Playwright is not installed. Run: npm i --no-save playwright && npx playwright install chromium');
    process.exit(2);
}
const { chromium } = loadPlaywright();

const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
// `state.down` makes the server drop every connection, which is what "offline"
// looks like to BOTH the page and the service worker. (Playwright's
// context.setOffline() is not used: it does not reliably cover requests the
// service worker itself makes, so the fallback would never be exercised.)
const state = { down: false };
function serve() {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            if (state.down) return req.destroy();
            let p = decodeURIComponent(req.url.split('?')[0]);
            if (p === '/') p = '/index.html';
            const file = path.join(ROOT, p);
            if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.statusCode = 404; return res.end('not found'); }
            res.setHeader('Content-Type', MIME[path.extname(file)] || 'application/octet-stream');
            res.end(fs.readFileSync(file));
        });
        server.listen(0, '127.0.0.1', () => resolve(server));
    });
}

const results = [];
function check(name, ok, detail = '') { results.push({ name, ok: !!ok, detail }); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `\n         -> ${detail}` : ''}`); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, { timeout = 6000, every = 100 } = {}) {
    const end = Date.now() + timeout;
    for (;;) {
        const v = await fn();
        if (v) return v;
        if (Date.now() > end) return null;
        await sleep(every);
    }
}

(async () => {
    const server = await serve();
    const origin = `http://localhost:${server.address().port}`;
    const browser = await chromium.launch({ channel: 'chromium' });
    let exitCode = 0;
    try {
        const ctx = await browser.newContext();
        await ctx.grantPermissions(['notifications'], { origin });
        // No internet in tests (and none wanted): fail third-party requests fast.
        await ctx.route((u) => u.hostname !== 'localhost', (r) => r.abort());
        const page = await ctx.newPage();
        const pageErrors = [];
        page.on('pageerror', (e) => pageErrors.push(e.message));
        await page.goto(`${origin}/offline.html`);

        console.log('Service worker install / activate');
        // A cache left behind by the previous release, to prove activation cleans it.
        await page.evaluate(async (name) => { await (await caches.open(name)).put('/stale', new Response('old')); }, PREVIOUS_CACHE_NAME);
        await page.evaluate(() => {
            window.__messages = [];
            navigator.serviceWorker.addEventListener('message', (e) => window.__messages.push(e.data));
        });
        const cdp = await ctx.newCDPSession(page);
        const registrations = [];
        cdp.on('ServiceWorker.workerRegistrationUpdated', (e) => registrations.push(...e.registrations));
        await cdp.send('ServiceWorker.enable');
        const scope = await page.evaluate(async () => {
            const reg = await navigator.serviceWorker.register('/service-worker.js');
            await navigator.serviceWorker.ready;
            return reg.scope;
        });
        check('worker registers at the site root', scope === `${origin}/`, scope);
        check('notification permission is granted in this context', await page.evaluate(() => Notification.permission) === 'granted');

        const cacheNames = await waitFor(async () => {
            const names = await page.evaluate(() => caches.keys());
            return names.includes(CURRENT_CACHE_NAME) && !names.includes(PREVIOUS_CACHE_NAME) ? names : null;
        });
        check(`activation creates the ${CURRENT_CACHE_NAME} cache and deletes the old ${PREVIOUS_CACHE_NAME} one`, !!cacheNames, JSON.stringify(await page.evaluate(() => caches.keys())));

        const registration = await waitFor(() => registrations.length ? registrations[registrations.length - 1] : null);
        if (!registration) throw new Error('DevTools never reported the service worker registration');

        // ---- helpers bound to this page --------------------------------------
        const notifications = () => page.evaluate(async () => {
            const reg = await navigator.serviceWorker.ready;
            return (await reg.getNotifications()).map((n) => ({ title: n.title, body: n.body, tag: n.tag, data: n.data, icon: n.icon, badge: n.badge, renotify: n.renotify }));
        });
        const clearNotifications = () => page.evaluate(async () => {
            const reg = await navigator.serviceWorker.ready;
            (await reg.getNotifications()).forEach((n) => n.close());
        });
        async function push(data) {
            await cdp.send('ServiceWorker.deliverPushMessage', {
                origin, registrationId: registration.registrationId, data: typeof data === 'string' ? data : JSON.stringify(data)
            });
        }
        async function pushAndWait(data, predicate) {
            await push(data);
            return waitFor(async () => { const all = await notifications(); return predicate(all) ? all : null; });
        }

        console.log('Push handler in a real engine');
        let all = await pushAndWait({ type: 'new_message', title: 'New message from Amina', body: 'Is the phone still available?', link: 'messages.html?conversation=c1' }, (a) => a.length === 1);
        let n = all && all[0];
        check('a push shows a notification with the payload title and body', n && n.title === 'New message from Amina' && n.body === 'Is the phone still available?', JSON.stringify(all));
        check('the notification carries the resolved app link and type', n && n.data && n.data.url === '/messages.html?conversation=c1' && n.data.type === 'new_message');
        check('the notification is tagged per conversation and set to renotify', n && n.tag === 'ns-msg-c1' && n.renotify === true);
        check('icon and badge are absolute same-origin URLs', n && n.icon === `${origin}/assets/brand/png/icon/icon-192.png` && n.badge === `${origin}/assets/brand/png/badge/new_message.png`);

        const assetInfo = await page.evaluate(async ({ icon, badge }) => {
            const out = {};
            for (const [k, u] of Object.entries({ icon, badge })) { const r = await fetch(u); out[k] = { ok: r.ok, type: r.headers.get('content-type') }; }
            return out;
        }, { icon: n && n.icon, badge: n && n.badge });
        check('icon and badge URLs really serve PNG images', assetInfo.icon.ok && assetInfo.badge.ok && assetInfo.icon.type === 'image/png' && assetInfo.badge.type === 'image/png', JSON.stringify(assetInfo));

        const badgeAlpha = await page.evaluate(async (u) => {
            const img = new Image(); img.src = u; await img.decode();
            const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
            const g = c.getContext('2d'); g.drawImage(img, 0, 0);
            const px = g.getImageData(0, 0, c.width, c.height).data;
            let opaque = 0; let clear = 0;
            for (let i = 3; i < px.length; i += 4) { if (px[i] > 200) opaque += 1; else if (px[i] < 20) clear += 1; }
            const total = px.length / 4;
            return { w: c.width, h: c.height, opaque: opaque / total, clear: clear / total };
        }, n && n.badge);
        check('the badge is a glyph on a transparent background (Android only reads its alpha)',
            badgeAlpha.w === 96 && badgeAlpha.h === 96 && badgeAlpha.clear > 0.3 && badgeAlpha.opaque > 0.2 && badgeAlpha.opaque < 0.7, JSON.stringify(badgeAlpha));

        all = await pushAndWait({ type: 'new_message', title: 'New message from Amina', body: 'Second message', link: 'messages.html?conversation=c1' }, (a) => a.some((x) => x.body === 'Second message'));
        check('a second message in the same conversation REPLACES the first (one notification)', all && all.length === 1 && all[0].body === 'Second message', JSON.stringify(all));
        all = await pushAndWait({ type: 'new_message', title: 'New message from Brian', body: 'Hello', link: 'messages.html?conversation=c2' }, (a) => a.length === 2);
        check('a message in a different conversation is a separate notification', !!all && all.length === 2, JSON.stringify(all));

        await clearNotifications();
        await push({ type: 'new_order', title: 'New order', body: 'Order #1', link: 'dashboard.html#orders' });
        all = await pushAndWait({ type: 'new_order', title: 'New order', body: 'Order #2', link: 'dashboard.html#orders' }, (a) => a.length === 2);
        check('two orders (same link) stack instead of replacing each other', !!all && all.length === 2 && all.every((x) => x.tag === '' && x.data.url === '/dashboard.html#orders'), JSON.stringify(all));
        check('an order notification uses its own badge, distinct from the message badge',
            all && all[0].badge === `${origin}/assets/brand/png/badge/new_order.png`, JSON.stringify(all));

        console.log('Badge differentiation across every known type, in a real engine');
        await clearNotifications();
        const perTypeBadges = ['new_message', 'new_order', 'low_stock', 'order_cancelled', 'new_product', 'subscription'];
        const seenBadges = [];
        for (const type of perTypeBadges) {
            await clearNotifications();
            const shown = await pushAndWait({ type, title: 't', body: 'b', link: '/' }, (a) => a.length === 1);
            seenBadges.push(shown && shown[0] && shown[0].badge);
        }
        check('every known type resolves to its own real, distinct badge URL',
            seenBadges.every((b, i) => b === `${origin}/assets/brand/png/badge/${perTypeBadges[i]}.png`)
                && new Set(seenBadges).size === perTypeBadges.length,
            JSON.stringify(seenBadges));
        const perTypeAssetInfo = await page.evaluate(async (urls) => {
            const out = {};
            for (const u of urls) { const r = await fetch(u); out[u] = { ok: r.ok, type: r.headers.get('content-type') }; }
            return out;
        }, seenBadges);
        check('every per-type badge URL really serves a PNG image',
            seenBadges.every((u) => perTypeAssetInfo[u] && perTypeAssetInfo[u].ok && perTypeAssetInfo[u].type === 'image/png'),
            JSON.stringify(perTypeAssetInfo));

        await clearNotifications();
        all = await pushAndWait({ type: 'some_unrecognized_type', title: 't', body: 'b', link: '/' }, (a) => a.length === 1);
        check('an unrecognized type falls back to the plain brand badge',
            all && all[0].badge === `${origin}/assets/brand/png/badge/badge-96.png`, JSON.stringify(all));

        console.log('Bad input still yields a visible notification');
        await clearNotifications();
        all = await pushAndWait('', (a) => a.length === 1);
        check('an empty push shows the default notification', !!all && all[0].title === 'NextaStore' && all[0].data.url === '/', JSON.stringify(all));
        await clearNotifications();
        all = await pushAndWait('this is not json', (a) => a.length === 1);
        check('a non-JSON push shows its text as the body', !!all && all[0].title === 'NextaStore' && all[0].body === 'this is not json', JSON.stringify(all));
        await clearNotifications();
        all = await pushAndWait({ title: 'Click me', link: 'https://evil.example/phish' }, (a) => a.length === 1);
        check('a cross-origin link in the payload is replaced with the app home', !!all && all[0].data.url === '/', JSON.stringify(all));
        await clearNotifications();
        all = await pushAndWait({ title: 'x', link: 'javascript:alert(1)' }, (a) => a.length === 1);
        check('a javascript: link is replaced with the app home', !!all && all[0].data.url === '/', JSON.stringify(all));

        console.log('Open pages are told about the push');
        const messages = await waitFor(async () => {
            const m = await page.evaluate(() => window.__messages);
            return m.length >= 4 ? m : null;
        });
        check('the page receives "ns-push-received" messages from the worker', !!messages && messages.every((m) => m.type === 'ns-push-received'), JSON.stringify(messages));
        check('...carrying the notification type', !!messages && messages[0].notificationType === 'new_message');

        console.log('Existing offline behaviour is unchanged');
        await page.goto(`${origin}/offline.html`); // make sure the page is controlled and precache is settled
        state.down = true;
        try {
            await page.goto(`${origin}/marketplace.html`, { waitUntil: 'domcontentloaded' });
            const title = await page.title();
            check('offline navigation to an uncached page falls back to offline.html', /offline/i.test(title), title);
        } catch (err) {
            check('offline navigation to an uncached page falls back to offline.html', false, err.message);
        }
        state.down = false;

        check('no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));
    } catch (err) {
        console.error(err);
        exitCode = 1;
    } finally {
        await browser.close();
        server.close();
    }
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n${results.length - failed}/${results.length} real-browser push checks passed.`);
    process.exitCode = exitCode || (failed ? 1 : 0);
})();
