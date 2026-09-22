#!/usr/bin/env node
'use strict';
/*
 * Runs the REAL service-worker.js (repo root) in a Node sandbox with fake
 * service-worker globals, and checks the Web Push handlers: `push`,
 * `notificationclick` and `pushsubscriptionchange`.
 *
 *   npm run test:push
 *
 * Nothing here needs a browser, a network or a database, so it is fast and
 * deterministic. What it can NOT tell you is whether a real browser and a
 * real phone behave the same — see scripts/push-sw-browser-test.js for the
 * real-Chromium half (push delivery only; clicking a notification cannot be
 * automated in any browser, which is why the click routing is tested here).
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..', '..');
const SW_SOURCE = fs.readFileSync(path.join(root, 'service-worker.js'), 'utf8');
const ORIGIN = 'https://shop.example';

const results = [];
function check(name, ok, detail = '') { results.push({ name, ok: !!ok, detail }); }

/** Builds a fresh worker global and returns helpers to fire events into it. */
function createWorker({ windows = [] } = {}) {
    const listeners = {};
    const state = { shown: [], opened: [], subscribeCalls: [], cachesDeleted: [], cacheNames: [], subscribeImpl: null, matchAllImpl: null };

    const self = {
        location: { origin: ORIGIN },
        registration: {
            scope: `${ORIGIN}/`,
            showNotification: async (title, options) => { state.shown.push({ title, options }); },
            pushManager: {
                subscribe: async (opts) => {
                    state.subscribeCalls.push(opts);
                    if (state.subscribeImpl) return state.subscribeImpl(opts);
                    return { toJSON: () => ({ endpoint: 'https://push.example/new', keys: { p256dh: 'p', auth: 'a' } }) };
                }
            }
        },
        clients: {
            matchAll: async () => (state.matchAllImpl ? state.matchAllImpl() : windows),
            openWindow: async (url) => { state.opened.push(url); },
            claim: async () => {}
        },
        skipWaiting: async () => {},
        addEventListener: (type, fn) => { listeners[type] = fn; }
    };
    const fakeCaches = {
        keys: async () => state.cacheNames,
        delete: async (n) => { state.cachesDeleted.push(n); return true; },
        open: async () => ({ put: async () => {}, match: async () => undefined })
    };

    vm.runInNewContext(SW_SOURCE, {
        self, caches: fakeCaches, fetch: async () => ({ ok: false }), URL, Promise, console, setTimeout, Object, String, Array, JSON, RegExp
    }, { filename: 'service-worker.js' });

    /** Dispatches an event and waits for everything handed to waitUntil. */
    async function fire(type, event) {
        const waits = [];
        event.waitUntil = (p) => { waits.push(p); };
        if (!listeners[type]) throw new Error(`no ${type} listener registered`);
        listeners[type](event);
        await Promise.all(waits);
        return { waits: waits.length };
    }

    return { self, state, listeners, fire };
}

function pushEvent(body) {
    if (body === undefined) return { data: null };
    const raw = typeof body === 'string' ? body : JSON.stringify(body);
    return {
        data: {
            json: () => JSON.parse(raw),
            text: () => raw
        }
    };
}

function fakeClient(url, { visible = true, focusImpl, navigateImpl } = {}) {
    const client = {
        url, visibilityState: visible ? 'visible' : 'hidden', focused: false,
        focusCalls: 0, navigateCalls: [], messages: [],
        focus: async () => {
            client.focusCalls += 1;
            if (focusImpl) return focusImpl(client);
            client.focused = true;
            return client;
        },
        navigate: async (target) => {
            client.navigateCalls.push(target);
            if (navigateImpl) return navigateImpl(target);
            client.url = target;
            return client;
        },
        postMessage: (m) => { client.messages.push(m); }
    };
    return client;
}

function clickEvent(data) {
    const notification = { data, closed: 0, close() { this.closed += 1; } };
    return { notification };
}

(async () => {
    // ---------------------------------------------------------------- push --
    {
        const w = createWorker();
        await w.fire('push', pushEvent({ type: 'new_message', title: 'New message from Amina', body: 'Is the phone still available?', link: 'messages.html?conversation=c1' }));
        const n = w.state.shown[0];
        check('push: shows exactly one notification for one push', w.state.shown.length === 1);
        check('push: title and body come from the payload', n.title === 'New message from Amina' && n.options.body === 'Is the phone still available?');
        check('push: uses the brand icon and the monochrome badge',
            n.options.icon === '/assets/brand/png/icon/icon-192.png' && n.options.badge === '/assets/brand/png/badge/badge-96.png');
        check('push: relative server link becomes a root-relative app path', n.options.data.url === '/messages.html?conversation=c1');
        check('push: message notification is tagged per conversation and renotifies',
            n.options.tag === 'ns-msg-c1' && n.options.renotify === true);
        check('push: type is carried through to the click handler', n.options.data.type === 'new_message');
    }
    {
        const w = createWorker();
        await w.fire('push', pushEvent({ type: 'new_message', title: 'a', link: 'messages.html?conversation=c1' }));
        await w.fire('push', pushEvent({ type: 'new_message', title: 'b', link: 'messages.html?conversation=c1' }));
        await w.fire('push', pushEvent({ type: 'new_message', title: 'c', link: 'messages.html?conversation=c2' }));
        const tags = w.state.shown.map((s) => s.options.tag);
        check('push: same conversation shares a tag (newest replaces older), other conversations do not',
            tags[0] === tags[1] && tags[1] !== tags[2], tags.join(','));
    }
    {
        const w = createWorker();
        await w.fire('push', pushEvent({ type: 'new_order', title: 'New order', body: 'Order #1', link: 'dashboard.html#orders' }));
        await w.fire('push', pushEvent({ type: 'new_order', title: 'New order', body: 'Order #2', link: 'dashboard.html#orders' }));
        const [a, b] = w.state.shown.map((s) => s.options);
        check('push: orders are NOT tagged, so two orders stack instead of replacing each other',
            !('tag' in a) && !('tag' in b) && !('renotify' in a));
        check('push: order link keeps its #orders hash', a.data.url === '/dashboard.html#orders');
    }
    {
        const w = createWorker();
        await w.fire('push', pushEvent({ type: 'new_message', title: 'Order update', link: 'orders.html?order=o1' }));
        check('push: a new_message about an ORDER (not a chat) is not collapsed as a conversation', !('tag' in w.state.shown[0].options));
    }
    {
        const w = createWorker();
        await w.fire('push', pushEvent({ type: 'low_stock', title: 'Low stock', link: '/subscription.html' }));
        check('push: root-relative link is accepted as-is', w.state.shown[0].options.data.url === '/subscription.html');
        await w.fire('push', pushEvent({ type: 'x', title: 't', link: `${ORIGIN}/orders.html?order=9` }));
        check('push: absolute same-origin link is reduced to a path', w.state.shown[1].options.data.url === '/orders.html?order=9');
    }

    // Robustness: a push must ALWAYS end in a visible notification.
    {
        const w = createWorker();
        const r = await w.fire('push', pushEvent(undefined));
        const s = w.state.shown[0];
        check('push: no data at all still shows a notification', w.state.shown.length === 1);
        check('push: ...with the default title, empty body and a link home', s.title === 'NextaStore' && s.options.body === '' && s.options.data.url === '/');
        check('push: the notification work is handed to waitUntil (worker is not killed early)', r.waits === 1);
    }
    {
        const w = createWorker();
        await w.fire('push', pushEvent('Your order shipped'));
        check('push: plain-text payload becomes the body', w.state.shown[0].options.body === 'Your order shipped' && w.state.shown[0].title === 'NextaStore');
    }
    {
        const w = createWorker();
        await w.fire('push', pushEvent('{ not json'));
        await w.fire('push', pushEvent([1, 2, 3]));
        await w.fire('push', pushEvent('"just a string"'));
        await w.fire('push', pushEvent('null'));
        check('push: broken JSON, an array, a bare string and null each still show a notification', w.state.shown.length === 4);
        check('push: ...all with the safe defaults', w.state.shown.slice(1).every((s) => s.title === 'NextaStore' && s.options.data.url === '/'));
    }
    {
        const w = createWorker();
        await w.fire('push', pushEvent({ type: 42, title: 12345, body: { x: 1 }, link: ['a'] }));
        const s = w.state.shown[0];
        check('push: non-string fields fall back to defaults instead of throwing',
            s.title === 'NextaStore' && s.options.body === '' && s.options.data.url === '/' && s.options.data.type === 'general');
    }
    {
        const w = createWorker();
        await w.fire('push', pushEvent({ title: 'T'.repeat(500), body: 'B'.repeat(2000), link: '' }));
        const s = w.state.shown[0];
        check('push: title and body are length-capped', s.title.length === 120 && s.options.body.length === 300);
        await w.fire('push', pushEvent({ title: '  padded  ', body: '  x  ' }));
        check('push: surrounding whitespace is trimmed', w.state.shown[1].title === 'padded' && w.state.shown[1].options.body === 'x');
    }

    // Links: nothing that leaves the site or isn't a normal app page may be opened.
    {
        const hostile = [
            'https://evil.example/phish', '//evil.example/x', '\\\\evil.example\\x', 'javascript:alert(1)',
            'data:text/html,<script>1</script>', `${ORIGIN}.evil.example/`, 'http://shop.example/orders.html',
            '/a/b.html', '/../etc/passwd', '/api/user/me', '/js/main.js', '/orders.html/extra', 'orders.html%2F..%2Fx'
        ];
        const w = createWorker();
        for (const link of hostile) await w.fire('push', pushEvent({ title: 't', link }));
        const bad = w.state.shown.map((s, i) => [hostile[i], s.options.data.url]).filter(([, url]) => url !== '/');
        check('push: hostile, cross-origin and non-page links all collapse to "/"', bad.length === 0, JSON.stringify(bad));
    }

    // Open tabs get told so the bell can refresh; that must never block the notification.
    {
        const c1 = fakeClient(`${ORIGIN}/orders.html`);
        const w = createWorker({ windows: [c1] });
        await w.fire('push', pushEvent({ type: 'new_order', title: 't' }));
        check('push: open pages are told a push arrived', c1.messages.length === 1 && c1.messages[0].type === 'ns-push-received' && c1.messages[0].notificationType === 'new_order');
    }
    {
        const broken = fakeClient(`${ORIGIN}/orders.html`);
        broken.postMessage = () => { throw new Error('gone'); };
        const w = createWorker({ windows: [broken] });
        let threw = false;
        try { await w.fire('push', pushEvent({ title: 't' })); } catch (e) { threw = true; }
        check('push: a page that throws on postMessage does not break the push', !threw && w.state.shown.length === 1);
        const w2 = createWorker();
        w2.state.matchAllImpl = async () => { throw new Error('clients unavailable'); };
        threw = false;
        try { await w2.fire('push', pushEvent({ title: 't' })); } catch (e) { threw = true; }
        check('push: clients.matchAll failing does not break the push', !threw && w2.state.shown.length === 1);
    }

    // ------------------------------------------------------ notificationclick --
    {
        const w = createWorker();
        const ev = clickEvent({ url: '/messages.html?conversation=c1' });
        await w.fire('notificationclick', ev);
        check('click: closes the notification', ev.notification.closed === 1);
        check('click: with no window open, opens one at the absolute target', w.state.opened.length === 1 && w.state.opened[0] === `${ORIGIN}/messages.html?conversation=c1`, w.state.opened.join());
    }
    {
        const other = fakeClient(`${ORIGIN}/marketplace.html`);
        const w = createWorker({ windows: [other] });
        await w.fire('notificationclick', clickEvent({ url: '/orders.html?order=o1' }));
        check('click: an open window on another page is focused and navigated', other.focusCalls === 1 && other.navigateCalls[0] === `${ORIGIN}/orders.html?order=o1`);
        check('click: ...and no second window is opened', w.state.opened.length === 0);
    }
    {
        const same = fakeClient(`${ORIGIN}/messages.html?conversation=c1`);
        const w = createWorker({ windows: [same] });
        await w.fire('notificationclick', clickEvent({ url: '/messages.html?conversation=c1' }));
        check('click: a window already on the target page is only focused (no reload)', same.focusCalls === 1 && same.navigateCalls.length === 0 && w.state.opened.length === 0);
    }
    {
        const hidden = fakeClient(`${ORIGIN}/marketplace.html`, { visible: false });
        const visible = fakeClient(`${ORIGIN}/cart.html`, { visible: true });
        const w = createWorker({ windows: [hidden, visible] });
        await w.fire('notificationclick', clickEvent({ url: '/dashboard.html#orders' }));
        check('click: prefers the visible window over a hidden one', visible.focusCalls === 1 && hidden.focusCalls === 0);
    }
    {
        const wins = [fakeClient(`${ORIGIN}/marketplace.html`, { visible: false }), fakeClient(`${ORIGIN}/messages.html?conversation=c9`, { visible: false })];
        const w = createWorker({ windows: wins });
        await w.fire('notificationclick', clickEvent({ url: '/messages.html?conversation=c9' }));
        check('click: an exact-page match wins even if it is hidden', wins[1].focusCalls === 1 && wins[0].focusCalls === 0 && wins[1].navigateCalls.length === 0);
    }
    {
        const stubborn = fakeClient(`${ORIGIN}/marketplace.html`, { navigateImpl: async () => { throw new Error('not controlled'); } });
        const w = createWorker({ windows: [stubborn] });
        await w.fire('notificationclick', clickEvent({ url: '/orders.html' }));
        check('click: if navigate() rejects, falls back to opening a new window', w.state.opened.length === 1 && w.state.opened[0] === `${ORIGIN}/orders.html`);
    }
    {
        const stuck = fakeClient(`${ORIGIN}/marketplace.html`, { focusImpl: async () => { throw new Error('no activation'); } });
        const w = createWorker({ windows: [stuck] });
        await w.fire('notificationclick', clickEvent({ url: '/orders.html' }));
        check('click: if focus() rejects, falls back to opening a new window', w.state.opened.length === 1);
    }
    {
        const w = createWorker();
        await w.fire('notificationclick', clickEvent({ url: 'https://evil.example/login' }));
        await w.fire('notificationclick', clickEvent(undefined));
        await w.fire('notificationclick', clickEvent({ url: 12 }));
        check('click: a tampered, missing or non-string url opens the app home, never the foreign site',
            w.state.opened.length === 3 && w.state.opened.every((u) => u === `${ORIGIN}/`), w.state.opened.join());
    }
    {
        const foreign = fakeClient('https://evil.example/');
        const w = createWorker({ windows: [foreign] });
        await w.fire('notificationclick', clickEvent({ url: '/orders.html' }));
        check('click: a window on another origin is never reused', foreign.focusCalls === 0 && w.state.opened.length === 1);
    }

    // ------------------------------------------------- pushsubscriptionchange --
    {
        const c = fakeClient(`${ORIGIN}/messages.html`);
        const w = createWorker({ windows: [c] });
        const fresh = { toJSON: () => ({ endpoint: 'https://push.example/fresh', keys: { p256dh: 'P', auth: 'A' } }) };
        await w.fire('pushsubscriptionchange', { newSubscription: fresh, oldSubscription: null });
        check('subscriptionchange: a subscription the browser already made is passed to the open page',
            c.messages.length === 1 && c.messages[0].type === 'ns-push-subscription-changed' && c.messages[0].subscription.endpoint === 'https://push.example/fresh');
        check('subscriptionchange: ...without subscribing a second time', w.state.subscribeCalls.length === 0);
    }
    {
        const c = fakeClient(`${ORIGIN}/messages.html`);
        const w = createWorker({ windows: [c] });
        const key = new Uint8Array([4, 1, 2, 3]).buffer;
        await w.fire('pushsubscriptionchange', { oldSubscription: { options: { applicationServerKey: key } } });
        check('subscriptionchange: with only the old subscription, re-subscribes with the same key, user-visible',
            w.state.subscribeCalls.length === 1 && w.state.subscribeCalls[0].applicationServerKey === key && w.state.subscribeCalls[0].userVisibleOnly === true);
        check('subscriptionchange: ...and hands the new one to the page', c.messages[0].subscription && c.messages[0].subscription.endpoint === 'https://push.example/new');
    }
    {
        const c = fakeClient(`${ORIGIN}/messages.html`);
        const w = createWorker({ windows: [c] });
        w.state.subscribeImpl = async () => { throw new Error('permission revoked'); };
        let threw = false;
        try { await w.fire('pushsubscriptionchange', { oldSubscription: { options: { applicationServerKey: new ArrayBuffer(4) } } }); } catch (e) { threw = true; }
        check('subscriptionchange: a failed re-subscribe does not throw and tells the page there is no subscription',
            !threw && c.messages.length === 1 && c.messages[0].subscription === null);
        const w2 = createWorker({ windows: [fakeClient(`${ORIGIN}/x.html`)] });
        await w2.fire('pushsubscriptionchange', { oldSubscription: null });
        check('subscriptionchange: no old subscription and no new one means no subscribe attempt', w2.state.subscribeCalls.length === 0);
    }

    // ---------------------------------------- existing caching behaviour intact --
    {
        // Built from whatever CACHE_VERSION actually is (see the check
        // just below) rather than hardcoded 'v6'/'v7' — otherwise this
        // test silently starts asserting the wrong thing every time that
        // version is bumped, exactly what happened here going from v7 to
        // v8: the real worker would then have "cleaned up" both v6 AND v7
        // (neither matches the current v8), not just v6.
        const currentVersionNum = Number((SW_SOURCE.match(/CACHE_VERSION = 'v(\d+)'/) || [])[1] || 7);
        const currentCacheName = `nextastore-cache-v${currentVersionNum}`;
        const previousCacheName = `nextastore-cache-v${currentVersionNum - 1}`;
        const w = createWorker();
        w.state.cacheNames = [previousCacheName, currentCacheName, 'someone-elses-cache'];
        await w.fire('activate', {});
        check('activate: drops old NextaStore caches, keeps the current one and other apps\' caches',
            w.state.cachesDeleted.length === 1 && w.state.cachesDeleted[0] === previousCacheName, w.state.cachesDeleted.join());
        // v7 or later, not pinned to exactly v7 — a later release (e.g. the
        // presence frontend's own cache bump) still counts as "bumped for
        // the push release", the same "at least" check qa-static.js makes.
        check('cache version was bumped for the push release', (() => {
            const m = SW_SOURCE.match(/CACHE_VERSION = 'v(\d+)'/);
            return !!m && Number(m[1]) >= 7;
        })());
        let responded = false;
        w.listeners.fetch({ request: { method: 'POST', url: `${ORIGIN}/api/x`, mode: 'cors' }, respondWith: () => { responded = true; } });
        w.listeners.fetch({ request: { method: 'GET', url: 'https://api.other.example/x', mode: 'cors' }, respondWith: () => { responded = true; } });
        check('fetch: POSTs and cross-origin requests are still left alone', !responded);
    }

    // ----------------------------------------------------------- static facts --
    check('service worker never touches window/document/localStorage (it has no page)', !/\b(localStorage|sessionStorage|document\.|window\.)/.test(SW_SOURCE.replace(/\/\/.*$/gm, '')));
    check('badge asset referenced by the worker exists', fs.existsSync(path.join(root, 'assets/brand/png/badge/badge-96.png')));
    check('icon asset referenced by the worker exists', fs.existsSync(path.join(root, 'assets/brand/png/icon/icon-192.png')));

    let failed = 0;
    for (const r of results) {
        console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok || !r.detail ? '' : `\n        -> ${r.detail}`}`);
        if (!r.ok) failed += 1;
    }
    console.log(`\n${results.length - failed}/${results.length} service-worker push checks passed.`);
    process.exitCode = failed ? 1 : 0;
})().catch((err) => { console.error(err); process.exitCode = 1; });
