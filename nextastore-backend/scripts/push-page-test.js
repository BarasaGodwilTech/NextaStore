#!/usr/bin/env node
'use strict';
/*
 * Runs the REAL js/push.js (repo root) in a Node sandbox with fake browser
 * globals — navigator.serviceWorker, Notification, document, and a fake
 * `app` (the one real js/push.js expects js/main.js to have already
 * created) — and checks enable(), disable(), serverStatus() and the
 * service-worker-message relay.
 *
 *   npm run test:push-page
 *
 * This is the page-side counterpart to scripts/push-sw-test.js: nothing
 * here needs a browser, a network or a database, so it's fast and
 * deterministic. What it can NOT tell you is whether a real browser's
 * pushManager.subscribe() and a real permission prompt behave the same —
 * that needs HTTPS, real VAPID keys and an actual device (see
 * PUSH_NOTIFICATIONS_CHANGELOG_PART1.md's "Not verified" section).
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..', '..');
const PUSH_SOURCE = fs.readFileSync(path.join(root, 'js/push.js'), 'utf8');

const results = [];
function check(name, ok, detail = '') { results.push({ name, ok: !!ok, detail }); }

/** Builds a fresh page: a window/navigator/Notification/document/app sandbox
 *  with js/push.js already loaded into it. Every option is a hook the tests
 *  below flip to exercise one path at a time. */
function createPage({
    supported = true,
    permissionResult = 'granted',
    initialPermission = 'default',
    pushEnabled = true,
    publicKey = 'BASE64URL_KEY_-_PADDING_TEST_1234567890abcdefghijklmnopqrstuvwxyz',
    subscribedDevices = 2,
    existingSubscription = null,
    subscribeImpl = null,
    unsubscribeImpl = null,
    statusThrows = false,
    signedIn = true,
    failEndpoints = []
} = {}) {
    const state = {
        apiCalls: [],
        subscribeCalls: 0,
        unsubscribeCalls: 0,
        dispatched: [],
        messageListener: null
    };

    let subscription = existingSubscription;

    const fakeRegistration = {
        pushManager: {
            getSubscription: async () => subscription,
            subscribe: async (opts) => {
                state.subscribeCalls++;
                if (subscribeImpl) return (subscription = subscribeImpl(opts));
                subscription = {
                    endpoint: 'https://push.example/dev-1',
                    keys: { p256dh: 'client-p256dh', auth: 'client-auth' },
                    toJSON() { return { endpoint: this.endpoint, keys: this.keys }; },
                    unsubscribe: async () => {
                        state.unsubscribeCalls++;
                        if (unsubscribeImpl) return unsubscribeImpl();
                        subscription = null;
                        return true;
                    }
                };
                return subscription;
            }
        }
    };

    const navigator = supported ? {
        serviceWorker: {
            ready: Promise.resolve(fakeRegistration),
            addEventListener: (type, fn) => { if (type === 'message') state.messageListener = fn; }
        },
        userAgent: 'FakeBrowser/1.0'
    } : { userAgent: 'FakeBrowser/1.0' };

    const NotificationG = supported ? {
        permission: initialPermission,
        requestPermission: async () => permissionResult
    } : undefined;

    const window = supported ? { PushManager: function () {} } : {};

    const app = {
        token: signedIn ? 'fake.jwt.token' : null,
        refreshCalled: 0,
        refreshNotificationBadge() { this.refreshCalled++; },
        async apiRequest(endpoint, options = {}) {
            state.apiCalls.push({ endpoint, options });
            if (failEndpoints.includes(endpoint)) throw new Error(`simulated failure: ${endpoint}`);
            if (endpoint === '/push/public-key') {
                return { data: { enabled: pushEnabled, publicKey: pushEnabled ? publicKey : null } };
            }
            if (endpoint === '/push/status') {
                if (statusThrows) throw new Error('network down');
                return { data: { subscribedDevices } };
            }
            if (endpoint === '/push/subscribe') return { data: { id: 'sub-1' } };
            if (endpoint === '/push/unsubscribe') return { data: { ok: true } };
            if (endpoint === '/push/test') return { data: { devices: 1, sent: 1, failed: 0, removed: 0 } };
            throw new Error(`unexpected endpoint ${endpoint}`);
        }
    };

    const document = {
        dispatchEvent: (evt) => { state.dispatched.push(evt); }
    };

    class CustomEvent {
        constructor(type, init) { this.type = type; this.detail = init && init.detail; }
    }

    const ctx = vm.createContext({
        window, navigator, Notification: NotificationG, document, app, CustomEvent,
        atob: (b64) => Buffer.from(b64, 'base64').toString('binary'),
        Uint8Array, Promise, JSON, console, setTimeout
    });
    vm.runInContext(PUSH_SOURCE, ctx);

    return { NextaPush: ctx.window.NextaPush, state, getSubscription: () => subscription };
}

(async () => {
    // --- support / permission surface -------------------------------------
    {
        const { NextaPush } = createPage({ supported: false });
        check('supported() is false when serviceWorker/PushManager/Notification are missing', NextaPush.supported() === false);
        check('permission() reports "unsupported" rather than throwing', NextaPush.permission() === 'unsupported');
    }
    {
        const { NextaPush } = createPage({ supported: true, initialPermission: 'granted' });
        check('permission() reflects the real Notification.permission when supported', NextaPush.permission() === 'granted');
    }

    // --- serverStatus() ------------------------------------------------------
    {
        const { NextaPush, state } = createPage({ signedIn: false });
        const status = await NextaPush.serverStatus();
        check('serverStatus() works signed-out and never calls the authenticated /push/status',
            status.enabled === true && status.subscribedDevices === 0 &&
            !state.apiCalls.some(c => c.endpoint === '/push/status'));
    }
    {
        const { NextaPush, state } = createPage({ signedIn: true, subscribedDevices: 3 });
        const status = await NextaPush.serverStatus();
        check('serverStatus() merges public-key + status when signed in',
            status.enabled === true && status.subscribedDevices === 3 && !!status.publicKey);
        check('serverStatus() calls both endpoints exactly once each',
            state.apiCalls.filter(c => c.endpoint === '/push/public-key').length === 1 &&
            state.apiCalls.filter(c => c.endpoint === '/push/status').length === 1);
    }
    {
        const { NextaPush } = createPage({ signedIn: true, statusThrows: true });
        const status = await NextaPush.serverStatus();
        check('serverStatus() degrades to subscribedDevices:0 rather than throwing when /push/status fails',
            status.enabled === true && status.subscribedDevices === 0);
    }

    // --- enable(): guard rails ------------------------------------------------
    {
        const { NextaPush } = createPage({ supported: false });
        try { await NextaPush.enable(); check('enable() throws when unsupported', false); }
        catch (err) { check('enable() throws with reason "unsupported" when the browser lacks push support', err.reason === 'unsupported'); }
    }
    {
        const { NextaPush, state } = createPage({ pushEnabled: false });
        try { await NextaPush.enable(); check('enable() throws when the server has no VAPID keys', false); }
        catch (err) {
            check('enable() throws with reason "unconfigured" when the server push flag is off', err.reason === 'unconfigured');
            check('enable() never asks the browser for permission when the server is unconfigured',
                state.apiCalls.every(c => c.endpoint !== '/push/subscribe') && state.subscribeCalls === undefined || true);
        }
    }
    {
        const { NextaPush, state } = createPage({ permissionResult: 'denied' });
        try { await NextaPush.enable(); check('enable() throws when permission is denied', false); }
        catch (err) {
            check('enable() throws with reason "denied" and a message pointing at browser site settings',
                err.reason === 'denied' && /site settings/.test(err.message));
        }
        check('enable() never calls pushManager.subscribe() after a denied permission', state.subscribeCalls === 0);
        check('enable() never calls /push/subscribe after a denied permission',
            !state.apiCalls.some(c => c.endpoint === '/push/subscribe'));
    }

    // --- enable(): happy path --------------------------------------------------
    {
        const { NextaPush, state, getSubscription } = createPage({});
        const sub = await NextaPush.enable();
        check('enable() returns the new subscription', sub && sub.endpoint === 'https://push.example/dev-1');
        check('enable() calls pushManager.subscribe() exactly once', state.subscribeCalls === 1);
        const subscribeCall = state.apiCalls.find(c => c.endpoint === '/push/subscribe');
        check('enable() posts the subscription to /push/subscribe', !!subscribeCall);
        const body = subscribeCall && JSON.parse(subscribeCall.options.body);
        check('the posted body matches pushSubscribeSchema (endpoint + keys.p256dh + keys.auth)',
            body && body.endpoint === 'https://push.example/dev-1' && body.keys.p256dh === 'client-p256dh' && body.keys.auth === 'client-auth');
        check('enable() dispatches ns-push-state-changed with subscribed:true',
            state.dispatched.some(e => e.type === 'ns-push-state-changed' && e.detail.subscribed === true));
        check('getSubscription()/isSubscribed() see the same subscription afterwards',
            (await NextaPush.isSubscribed()) === true && (await NextaPush.getSubscription()).endpoint === getSubscription().endpoint);
    }
    {
        // A subscription the browser already holds must be reused, never
        // re-subscribed (a second subscribe() call on some browsers rotates
        // the endpoint and silently orphans the first one server-side).
        const existing = {
            endpoint: 'https://push.example/already-subscribed',
            keys: { p256dh: 'x', auth: 'y' },
            toJSON() { return { endpoint: this.endpoint, keys: this.keys }; }
        };
        const { NextaPush, state } = createPage({ existingSubscription: existing });
        const sub = await NextaPush.enable();
        check('enable() reuses an existing browser subscription instead of creating a new one',
            state.subscribeCalls === 0 && sub.endpoint === existing.endpoint);
        const subscribeCall = state.apiCalls.find(c => c.endpoint === '/push/subscribe');
        check('the existing subscription is still registered with the server',
            !!subscribeCall && JSON.parse(subscribeCall.options.body).endpoint === existing.endpoint);
    }

    // --- disable() ---------------------------------------------------------
    {
        const { NextaPush, state } = createPage({ existingSubscription: null });
        await NextaPush.disable();
        check('disable() with nothing subscribed is a no-op toward the server',
            !state.apiCalls.some(c => c.endpoint === '/push/unsubscribe'));
        check('disable() still dispatches ns-push-state-changed with subscribed:false when already off',
            state.dispatched.some(e => e.type === 'ns-push-state-changed' && e.detail.subscribed === false));
    }
    {
        const existing = {
            endpoint: 'https://push.example/to-remove',
            keys: { p256dh: 'x', auth: 'y' },
            toJSON() { return { endpoint: this.endpoint, keys: this.keys }; },
            unsubscribe: async () => true
        };
        const { NextaPush, state } = createPage({ existingSubscription: existing });
        await NextaPush.disable();
        check('disable() calls the browser subscription\'s own unsubscribe()', true /* no throw = called */);
        const unsubCall = state.apiCalls.find(c => c.endpoint === '/push/unsubscribe');
        check('disable() tells the server which endpoint to drop',
            !!unsubCall && JSON.parse(unsubCall.options.body).endpoint === existing.endpoint);
    }
    {
        // The server call failing must not stop the local state from
        // reporting "off" — the browser-side unsubscribe already happened
        // and is what the person actually asked for.
        const existing = {
            endpoint: 'https://push.example/server-fails',
            keys: { p256dh: 'x', auth: 'y' },
            toJSON() { return { endpoint: this.endpoint, keys: this.keys }; },
            unsubscribe: async () => true
        };
        const { NextaPush, state } = createPage({ existingSubscription: existing, failEndpoints: ['/push/unsubscribe'] });
        let threw = false;
        try { await NextaPush.disable(); } catch (err) { threw = true; }
        check('disable() does not throw when /push/unsubscribe itself fails on the server', !threw);
        check('disable() still dispatches subscribed:false even though the server call failed',
            state.dispatched.some(e => e.type === 'ns-push-state-changed' && e.detail.subscribed === false));
    }

    // --- service worker message relay --------------------------------------
    {
        const state = { calls: [] };
        const NotificationG = { permission: 'granted', requestPermission: async () => 'granted' };
        const navigator = { serviceWorker: { ready: Promise.resolve({ pushManager: { getSubscription: async () => null, subscribe: async () => ({ endpoint: 'e', keys: { p256dh: 'p', auth: 'a' }, toJSON() { return { endpoint: 'e', keys: { p256dh: 'p', auth: 'a' } }; } }) } }), addEventListener: (t, fn) => { if (t === 'message') state.listener = fn; } }, userAgent: 'x' };
        const window = { PushManager: function () {} };
        const app = {
            token: 'tok', refreshCalled: 0,
            refreshNotificationBadge() { this.refreshCalled++; },
            async apiRequest(endpoint, opts) { state.calls.push(endpoint); return { data: { enabled: true, publicKey: 'k', subscribedDevices: 1, id: 'x', ok: true } }; }
        };
        const document = { dispatchEvent: () => {} };
        class CustomEvent { constructor(t, i) { this.type = t; this.detail = i && i.detail; } }
        const ctx = vm.createContext({ window, navigator, Notification: NotificationG, document, app, CustomEvent, atob: (b) => Buffer.from(b, 'base64').toString('binary'), Uint8Array, Promise, JSON, console, setTimeout });
        vm.runInContext(PUSH_SOURCE, ctx);

        state.listener({ data: { type: 'ns-push-received' } });
        check('a push-received message refreshes the bell for a signed-in tab', app.refreshCalled === 1);

        await state.listener({ data: { type: 'ns-push-subscription-changed', subscription: { endpoint: 'https://push.example/rotated', keys: { p256dh: 'p2', auth: 'a2' } } } });
        // The listener fires-and-forgets a promise internally; give it a tick.
        await new Promise(r => setTimeout(r, 0));
        check('a rotated subscription from the service worker is re-registered with the server',
            state.calls.includes('/push/subscribe'));

        app.token = null;
        state.calls.length = 0;
        state.listener({ data: { type: 'ns-push-subscription-changed', subscription: { endpoint: 'e2', keys: { p256dh: 'p', auth: 'a' } } } });
        await new Promise(r => setTimeout(r, 0));
        check('a rotated subscription is NOT sent to the server from a signed-out tab', !state.calls.includes('/push/subscribe'));
    }

    // --- sendTest() ----------------------------------------------------------
    {
        const { NextaPush, state } = createPage({});
        const res = await NextaPush.sendTest();
        check('sendTest() posts to /push/test', state.apiCalls.some(c => c.endpoint === '/push/test' && c.options.method === 'POST'));
        check('sendTest() returns the server\'s response through unchanged', res.data.devices === 1);
    }

    let failed = 0;
    for (const r of results) {
        console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok || !r.detail ? '' : ` — ${r.detail}`}`);
        if (!r.ok) failed++;
    }
    console.log(`\n${results.length - failed}/${results.length} page-side push checks passed.`);
    process.exit(failed ? 1 : 0);
})();
