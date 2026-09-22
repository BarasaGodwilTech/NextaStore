#!/usr/bin/env node
'use strict';
/*
 * Runs the REAL js/push.js and js/push-prompt.js (repo root) together in a
 * Node sandbox with a minimal fake DOM, navigator and localStorage, and
 * checks the package 2B soft prompt: when it shows, when it stays quiet,
 * the 3-day/14-day snooze escalation, the iOS "Add to Home Screen" variant,
 * and NextaPush.reregisterAfterCredentialChange().
 *
 *   npm run test:push-prompt
 *
 * Both files are loaded into the SAME vm context, in the same order a page
 * loads them (js/push.js first), so this also exercises the real
 * document.dispatchEvent → document.addEventListener wiring between them —
 * not just each file's own exports in isolation.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..', '..');
const PUSH_SOURCE = fs.readFileSync(path.join(root, 'js/push.js'), 'utf8');
const PROMPT_SOURCE = fs.readFileSync(path.join(root, 'js/push-prompt.js'), 'utf8');

const results = [];
function check(name, ok, detail = '') { results.push({ name, ok: !!ok, detail }); }

// ---- minimal fake DOM -------------------------------------------------------
// Just enough to run real innerHTML-templated banners: createElement, a
// crude <button class="..."> extractor for querySelector, click dispatch,
// and a document-level addEventListener/dispatchEvent pair so the real
// 'ns-push-state-changed' wiring between push.js and push-prompt.js works
// exactly as it does in a browser.
function extractButtons(html) {
    const buttons = [];
    const re = /<button[^>]*class="([^"]+)"[^>]*>/g;
    let m;
    while ((m = re.exec(html))) buttons.push(new FakeElement('button', m[1]));
    return buttons;
}

class FakeElement {
    constructor(tag, className = '') {
        this.tagName = tag;
        this.className = className;
        this._html = '';
        this.children = [];
        this._listeners = {};
        this._attrs = {};
        this.disabled = false;
        this.textContent = '';
        this._removed = false;
    }
    set innerHTML(html) { this._html = html; this.children = extractButtons(html); }
    get innerHTML() { return this._html; }
    setAttribute(k, v) { this._attrs[k] = v; }
    getAttribute(k) { return this._attrs[k]; }
    addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); }
    click() { (this._listeners.click || []).forEach(fn => fn()); }
    querySelector(sel) {
        const cls = sel.replace('.', '');
        return this.children.find(c => (c.className || '').split(' ').includes(cls)) || null;
    }
    appendChild(child) { this.children.push(child); return child; }
    remove() {
        this._removed = true;
        const i = (this.parent ? this.parent.children : []).indexOf(this);
        if (i >= 0) this.parent.children.splice(i, 1);
    }
}

function makeDocument() {
    const body = new FakeElement('body');
    const docListeners = {};
    return {
        body,
        readyState: 'complete',
        createElement(tag) { const el = new FakeElement(tag); el.parent = body; return el; },
        querySelector(sel) { return body.querySelector(sel); },
        addEventListener(type, fn) { (docListeners[type] = docListeners[type] || []).push(fn); },
        dispatchEvent(evt) { (docListeners[evt.type] || []).forEach(fn => fn(evt)); }
    };
}

function makeLocalStorage() {
    const store = {};
    return {
        getItem: k => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
        setItem: (k, v) => { store[k] = String(v); },
        removeItem: k => { delete store[k]; },
        _dump: () => ({ ...store })
    };
}

/** Builds a fresh page with both real files loaded into it, sharing one
 *  window/document/navigator/app/localStorage — exactly like a browser
 *  loading js/push.js then js/push-prompt.js off the same page. */
function createPage({
    signedIn = true,
    supported = true,
    permission = 'default',
    pushEnabled = true,
    publicKey = 'BASE64URL_KEY_-_PADDING_TEST_1234567890abcdefghijklmnopqrstuvwxyz',
    existingSubscription = null,
    userAgent = 'FakeBrowser/1.0',
    platform = 'FakePlatform',
    maxTouchPoints = 0,
    standalone = undefined,
    matchesStandaloneMedia = false,
    enableImpl = null // override NextaPush.enable() behaviour after load, for prompt-only tests
} = {}) {
    const state = { apiCalls: [], alerts: [], dispatched: [] };
    let subscription = existingSubscription;

    const fakeRegistration = {
        pushManager: {
            getSubscription: async () => subscription,
            subscribe: async () => {
                subscription = {
                    endpoint: 'https://push.example/dev-1',
                    keys: { p256dh: 'p', auth: 'a' },
                    toJSON() { return { endpoint: this.endpoint, keys: this.keys }; }
                };
                return subscription;
            }
        }
    };

    const navigator = {
        userAgent,
        platform,
        maxTouchPoints,
        standalone,
        ...(supported ? { serviceWorker: { ready: Promise.resolve(fakeRegistration), addEventListener: () => {} } } : {})
    };

    const NotificationG = { permission, requestPermission: async () => 'granted' };
    const window = supported ? { PushManager: function () {} } : {};
    window.matchMedia = () => ({ matches: matchesStandaloneMedia });
    window.navigator = navigator;

    const localStorage = makeLocalStorage();
    const document = makeDocument();

    const app = {
        token: signedIn ? 'fake.jwt.token' : null,
        showAlert(msg, type) { state.alerts.push({ msg, type }); },
        refreshNotificationBadge() {},
        async apiRequest(endpoint, options = {}) {
            state.apiCalls.push({ endpoint, options });
            if (endpoint === '/push/public-key') return { data: { enabled: pushEnabled, publicKey: pushEnabled ? publicKey : null } };
            if (endpoint === '/push/status') return { data: { subscribedDevices: subscription ? 1 : 0 } };
            if (endpoint === '/push/subscribe') return { data: { id: 'sub-1' } };
            if (endpoint === '/push/unsubscribe') return { data: { ok: true } };
            throw new Error(`unexpected endpoint ${endpoint}`);
        }
    };

    class CustomEvent {
        constructor(type, init) { this.type = type; this.detail = init && init.detail; }
    }

    const ctx = vm.createContext({
        window, navigator, Notification: supported ? NotificationG : undefined, document, app, localStorage, CustomEvent,
        atob: b => Buffer.from(b, 'base64').toString('binary'),
        Uint8Array, Promise, JSON, console, setTimeout, Date
    });
    vm.runInContext(PUSH_SOURCE, ctx);
    if (enableImpl) ctx.window.NextaPush.enable = enableImpl;
    vm.runInContext(PROMPT_SOURCE, ctx);

    return { NextaPush: ctx.window.NextaPush, NextaPushPrompt: ctx.window.NextaPushPrompt, document, localStorage, state, app };
}

(async () => {
    // --- basic gating: signed out, permission already decided, already subscribed, unconfigured server ---
    {
        const { NextaPushPrompt, document } = createPage({ signedIn: false });
        await NextaPushPrompt._maybeShow();
        check('Signed-out tab never sees the prompt', !document.querySelector('.push-soft-prompt'));
    }
    {
        const { NextaPushPrompt, document } = createPage({ permission: 'granted' });
        await NextaPushPrompt._maybeShow();
        check('Permission already granted: the prompt has nothing to offer', !document.querySelector('.push-soft-prompt'));
    }
    {
        const { NextaPushPrompt, document } = createPage({ permission: 'denied' });
        await NextaPushPrompt._maybeShow();
        check('Permission already denied: the prompt does not re-litigate the browser\u2019s own decision', !document.querySelector('.push-soft-prompt'));
    }
    {
        const existing = { endpoint: 'e', keys: { p256dh: 'p', auth: 'a' }, toJSON() { return { endpoint: this.endpoint, keys: this.keys }; } };
        const { NextaPushPrompt, document } = createPage({ existingSubscription: existing });
        await NextaPushPrompt._maybeShow();
        check('Already-subscribed device: the prompt stays quiet', !document.querySelector('.push-soft-prompt'));
    }
    {
        const { NextaPushPrompt, document } = createPage({ pushEnabled: false });
        await NextaPushPrompt._maybeShow();
        check('Server not configured for push: the prompt stays quiet rather than offering something broken', !document.querySelector('.push-soft-prompt'));
    }

    // --- the happy path: eligible, shows the enable banner ---
    {
        const { NextaPushPrompt, document } = createPage({});
        await NextaPushPrompt._maybeShow();
        const banner = document.querySelector('.push-soft-prompt');
        check('An eligible signed-in tab with a default permission sees the enable banner', !!banner);
        check('The banner has both a Turn on and a Not now action', !!banner.querySelector('.push-soft-prompt-enable') && !!banner.querySelector('.push-soft-prompt-dismiss'));
        check('The banner carries consent copy, not just a bare ask', /turn it off anytime in Settings/.test(banner.innerHTML));
    }

    // --- snooze escalation: 3 days, then 14 ---
    {
        const { NextaPushPrompt, document, localStorage } = createPage({});
        await NextaPushPrompt._maybeShow();
        document.querySelector('.push-soft-prompt').querySelector('.push-soft-prompt-dismiss').click();
        check('Dismissing removes the banner immediately', !document.querySelector('.push-soft-prompt'));
        let state = JSON.parse(localStorage.getItem('ns_push_prompt_v1'));
        const threeDaysMs = 3 * 24 * 60 * 60 * 1000;
        check('First dismissal snoozes for 3 days', state.dismissCount === 1 && Math.abs(state.snoozeUntil - (Date.now() + threeDaysMs)) < 5000);
        check('Immediately re-checking while snoozed stays quiet', NextaPushPrompt._isSnoozed() === true);

        // Force the snooze to have already elapsed, then dismiss again.
        localStorage.setItem('ns_push_prompt_v1', JSON.stringify({ dismissCount: 1, snoozeUntil: 0 }));
        await NextaPushPrompt._maybeShow();
        document.querySelector('.push-soft-prompt').querySelector('.push-soft-prompt-dismiss').click();
        state = JSON.parse(localStorage.getItem('ns_push_prompt_v1'));
        const fourteenDaysMs = 14 * 24 * 60 * 60 * 1000;
        check('Second dismissal snoozes for 14 days, not another 3', state.dismissCount === 2 && Math.abs(state.snoozeUntil - (Date.now() + fourteenDaysMs)) < 5000);
    }

    // --- enable button: happy path clears any snooze and turns push on for real ---
    {
        const { NextaPushPrompt, document, localStorage, state, app } = createPage({});
        localStorage.setItem('ns_push_prompt_v1', JSON.stringify({ dismissCount: 1, snoozeUntil: 0 }));
        await NextaPushPrompt._maybeShow();
        const banner = document.querySelector('.push-soft-prompt');
        banner.querySelector('.push-soft-prompt-enable').click();
        await new Promise(r => setTimeout(r, 0));
        await new Promise(r => setTimeout(r, 0));
        check('Clicking Turn on calls the real NextaPush.enable(), not a stand-in', state.apiCalls.some(c => c.endpoint === '/push/subscribe'));
        check('A successful enable removes the banner', !document.querySelector('.push-soft-prompt'));
        check('A successful enable clears any prior snooze', JSON.parse(localStorage.getItem('ns_push_prompt_v1')).dismissCount === 0);
        check('A successful enable tells the person it worked', app_alertSaysOn(state));
    }
    function app_alertSaysOn(state) { return state.alerts.some(a => a.type === 'success'); }

    // --- enable button: denied permission is not snoozed (permission() already blocks it) ---
    {
        const { NextaPushPrompt, document, localStorage } = createPage({
            enableImpl: async () => { const err = new Error('Notifications are blocked for this site.'); err.reason = 'denied'; throw err; }
        });
        await NextaPushPrompt._maybeShow();
        document.querySelector('.push-soft-prompt').querySelector('.push-soft-prompt-enable').click();
        await new Promise(r => setTimeout(r, 0));
        const state = JSON.parse(localStorage.getItem('ns_push_prompt_v1') || '{"dismissCount":0}');
        check('A denied permission from clicking Turn on is not snoozed (nothing to snooze against)', (state.dismissCount || 0) === 0);
        check('The banner is removed either way after a denied attempt', !document.querySelector('.push-soft-prompt'));
    }

    // --- banner closes itself if push gets enabled through another route while open ---
    {
        const { NextaPushPrompt, document } = createPage({});
        await NextaPushPrompt._maybeShow();
        check('Banner is open before the external event', !!document.querySelector('.push-soft-prompt'));
        // Fire the real event NextaPush.enable() would dispatch, without
        // going through enable() itself (simulating the bell's own "Turn on" row).
        document.dispatchEvent({ type: 'ns-push-state-changed', detail: { subscribed: true } });
        check('The prompt disappears once another route subscribes this device', !document.querySelector('.push-soft-prompt'));
    }

    // --- iOS guidance ---
    const IOS_UA_164 = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_4 like Mac OS X) AppleWebKit/605.1.15';
    const IOS_UA_150 = 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15';
    {
        const { NextaPushPrompt, document } = createPage({ supported: false, userAgent: IOS_UA_164, standalone: false });
        await NextaPushPrompt._maybeShow();
        const banner = document.querySelector('.push-soft-prompt');
        check('iPhone, 16.4+, not installed, no PushManager: shows the Add to Home Screen guidance', !!banner && /push-soft-prompt-ios/.test(banner.className));
        check('The iOS variant explains Share \u2192 Add to Home Screen', /Add to Home Screen/.test(banner.innerHTML));
        check('The iOS variant only offers a single dismiss action, not a Turn on button it cannot honour', !banner.querySelector('.push-soft-prompt-enable'));
    }
    {
        const { NextaPushPrompt, document } = createPage({ supported: false, userAgent: IOS_UA_164, standalone: true });
        await NextaPushPrompt._maybeShow();
        check('Already installed to the home screen (standalone): no guidance needed', !document.querySelector('.push-soft-prompt'));
    }
    {
        const { NextaPushPrompt, document } = createPage({ supported: false, userAgent: IOS_UA_150, standalone: false });
        await NextaPushPrompt._maybeShow();
        check('iOS below 16.4: no guidance, since installing would not unlock push anyway', !document.querySelector('.push-soft-prompt'));
    }
    {
        // Standalone iOS 16.4+ with real Web Push support shows the normal
        // enable banner, not the iOS guidance variant.
        const { NextaPushPrompt, document } = createPage({ supported: true, userAgent: IOS_UA_164, standalone: true });
        await NextaPushPrompt._maybeShow();
        const banner = document.querySelector('.push-soft-prompt');
        check('Installed iOS 16.4+ with real push support gets the normal enable banner, not iOS guidance', !!banner && !/push-soft-prompt-ios/.test(banner.className));
    }
    {
        const { NextaPushPrompt, document } = createPage({ supported: false, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' });
        await NextaPushPrompt._maybeShow();
        check('An unsupported desktop browser (not iOS) gets no banner at all', !document.querySelector('.push-soft-prompt'));
    }

    // --- reregisterAfterCredentialChange() ---
    {
        const existing = { endpoint: 'https://push.example/still-here', keys: { p256dh: 'p', auth: 'a' }, toJSON() { return { endpoint: this.endpoint, keys: this.keys }; } };
        const { NextaPush, state } = createPage({ existingSubscription: existing });
        await NextaPush.reregisterAfterCredentialChange();
        const call = state.apiCalls.find(c => c.endpoint === '/push/subscribe');
        check('reregisterAfterCredentialChange() re-sends the existing subscription to the server', !!call && JSON.parse(call.options.body).endpoint === existing.endpoint);
    }
    {
        const { NextaPush, state } = createPage({ existingSubscription: null });
        let threw = false;
        try { await NextaPush.reregisterAfterCredentialChange(); } catch (err) { threw = true; }
        check('reregisterAfterCredentialChange() is a silent no-op when this device has no subscription to hand back', !threw && !state.apiCalls.some(c => c.endpoint === '/push/subscribe'));
    }
    {
        // Even a failing /push/subscribe call must not throw out to the
        // caller — js/dashboard.js fires this without awaiting/catching.
        const existing = { endpoint: 'e', keys: { p256dh: 'p', auth: 'a' }, toJSON() { return { endpoint: this.endpoint, keys: this.keys }; } };
        const page = createPage({ existingSubscription: existing });
        page.app.apiRequest = async () => { throw new Error('network down'); };
        let threw = false;
        try { await page.NextaPush.reregisterAfterCredentialChange(); } catch (err) { threw = true; }
        check('reregisterAfterCredentialChange() never throws even if the server call fails', !threw);
    }

    let failed = 0;
    for (const r of results) {
        console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok || !r.detail ? '' : ` — ${r.detail}`}`);
        if (!r.ok) failed++;
    }
    console.log(`\n${results.length - failed}/${results.length} push-prompt checks passed.`);
    process.exit(failed ? 1 : 0);
})();
