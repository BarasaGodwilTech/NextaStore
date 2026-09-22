'use strict';
/*
 * Real-browser checks for the round-8 auth/session work.
 *
 *   npm i --no-save playwright && npx playwright install chromium   (once)
 *   npm run test:auth-browser                 # everything
 *   npm run test:auth-browser -- s3 s4        # just those scenarios
 *
 * Each scenario asserts what AUTH_AUDIT_CHANGELOG_ROUND8 says the code does.
 * A FAIL means the claim is not true in a real browser. See harness.js for what
 * is real (frontend, middleware.js, config.js) and what is a stand-in.
 */
const path = require('path');
const { start } = require('./harness');

function loadPlaywright() {
    try { return require('playwright'); } catch (e) { /* fall through */ }
    try { return require(path.join(require('child_process').execSync('npm root -g').toString().trim(), 'playwright')); } catch (e) { /* fall through */ }
    console.error('Playwright is not installed. Run: npm i --no-save playwright && npx playwright install chromium');
    process.exit(2);
}
const { chromium } = loadPlaywright();

const PORT = 4000;
const BASE = `http://localhost:${PORT}`;
const DAY = 86400;
const MIN = 60 * 1000;

const USERS = {
    seller: { email: 'seller@test.dev', password: 'Passw0rd!seller', id: 'u_seller' },
    buyer: { email: 'buyer@test.dev', password: 'Passw0rd!buyer', id: 'u_buyer' },
    buyer2: { email: 'buyer2@test.dev', password: 'Passw0rd!buyer2', id: 'u_buyer2' }
};

// ---- tiny assertion helpers -------------------------------------------------
const results = [];
let currentScenario = '';
function check(name, ok, detail = '') {
    results.push({ scenario: currentScenario, name, ok: !!ok, detail });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `\n         -> ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function ctl(p) { const r = await fetch(`${BASE}/__test/${p}`, { method: 'POST' }); return r.json(); }
async function serverLog() { return (await fetch(`${BASE}/__test/log`)).json(); }
const advanceServer = (seconds) => ctl(`advance?seconds=${seconds}`);

// ---- browser helpers --------------------------------------------------------
async function newContext(browser, { clock = false } = {}) {
    const ctx = await browser.newContext({ serviceWorkers: 'block' });
    // No internet in tests: fail third-party requests (fonts, icon CDN) fast.
    await ctx.route((u) => u.hostname !== 'localhost', (r) => r.abort());
    if (clock) await ctx.clock.install({ time: new Date() });
    return ctx;
}
const pageErrors = [];
async function newPage(ctx, label = 'page') {
    const page = await ctx.newPage();
    page.on('pageerror', (e) => pageErrors.push(`[${currentScenario}/${label}] ${e.message}`));
    return page;
}

// Pages in these tests navigate on their own (storage-event reloads, redirects), so
// reading state can land in the middle of one. Wait for the page to settle and retry
// rather than reporting a navigation as a failure.
async function identity(page) {
    for (let attempt = 0; attempt < 8; attempt++) {
        try { await page.waitForLoadState('load', { timeout: 5000 }); return await readIdentity(page); } catch (e) {
            if (!/context was destroyed|navigation|Target closed/i.test(e.message)) throw e;
            await sleep(250);
        }
    }
    return readIdentity(page);
}
const readIdentity = (page) => page.evaluate(() => {
    const read = (k) => localStorage.getItem(k) ?? sessionStorage.getItem(k);
    const t = read('nextastore_token');
    let claims = null;
    try { claims = t ? JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))) : null; } catch (e) { /* ignore */ }
    let cached = null;
    try { cached = JSON.parse(read('nextastore_user') || 'null'); } catch (e) { /* ignore */ }
    return {
        url: location.pathname + location.search,
        hasToken: !!t, token: t, tokenUser: claims?.userId ?? null, cachedUser: cached?.id ?? null,
        memoryUser: (typeof app !== 'undefined' && app.user && app.user.id) || null,
        memoryTokenUser: (typeof app !== 'undefined' && app.token) ? (JSON.parse(atob(app.token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).userId) : null
    };
});

async function uiLogin(page, who, { remember = false, query = '' } = {}) {
    await page.goto(`${BASE}/login.html${query}`);
    await page.fill('#email', who.email);
    await page.fill('#password', who.password);
    if (remember) await page.check('#rememberMe');
    await Promise.all([
        waitLeftLogin(page),
        page.click('button[type="submit"]')
    ]);
    await page.waitForLoadState('load');
    await sleep(250); // let loadUserData()/badge polling settle
}

// Polls the page's real current URL. Playwright's page.waitForURL() can miss a
// navigation that is followed straight away by another one (storage-event reload,
// then redirect to login), and reports a timeout although the URL was right within
// 300ms - so it is not used for anything in this file.
async function waitUrl(page, re, timeout = 6000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        const u = new URL(page.url());
        if (re.test(u.pathname + u.search)) return true;
        await sleep(50);
    }
    return false;
}
const waitLeftLogin = (page, timeout = 10000) => waitUrl(page, /^\/(?!login\.html)/, timeout);

async function freshState() { await ctl('reset'); }

// =============================================================================
// Scenario 1 - two tabs / stale tab (findings 2 and 4)
// =============================================================================
async function s1(browser) {
    currentScenario = 's1';
    console.log('\nS1  Two tabs on one browser (finding 2 / cross-tab sync)');

    // 1a: a second tab still showing the login form must not stay stale
    await freshState();
    let ctx = await newContext(browser);
    let p1 = await newPage(ctx, 'p1'); let p2 = await newPage(ctx, 'p2');
    await p2.goto(`${BASE}/login.html`);
    await uiLogin(p1, USERS.buyer, { remember: true, query: '?redirect=orders.html' });
    const left = await waitUrl(p2, /^\/(marketplace|orders)\.html/, 6000);
    const id2 = await identity(p2);
    check('1a  a second tab left on login.html is moved on once another tab signs in', left, `still at ${id2.url}`);
    check('1a  ...and it now acts as the person who signed in', id2.memoryUser === USERS.buyer.id, JSON.stringify({ memory: id2.memoryUser, token: id2.tokenUser }));
    await ctx.close();

    // 1b: sign out in one tab, a different person signs in on the same browser
    await freshState();
    ctx = await newContext(browser);
    p1 = await newPage(ctx, 'p1'); p2 = await newPage(ctx, 'p2');
    await uiLogin(p1, USERS.buyer, { remember: true, query: '?redirect=orders.html' });
    await p1.evaluate(() => localStorage.setItem('nextastore_cart_v1', JSON.stringify([{ id: 'prod1', qty: 1 }])));
    await p2.goto(`${BASE}/orders.html`); await sleep(300);
    await p2.evaluate(() => { app.endSession('logout'); window.location.href = 'index.html'; }); // what app.logout() does after the confirm
    const p1ToLogin = await waitUrl(p1, /login\.html/, 6000);
    check('1b  signing out in tab 2 sends tab 1 to the login page', p1ToLogin, `tab 1 is at ${(await identity(p1)).url}`);
    await uiLogin(p2, USERS.seller, { remember: true, query: '?redirect=orders.html' });
    await sleep(800);
    const a = await identity(p1);
    check('1b  tab 1 does NOT stay signed in as the previous person', a.memoryUser !== USERS.buyer.id && a.tokenUser !== USERS.buyer.id, JSON.stringify(a));
    check('1b  tab 1 follows the new sign-in (seller) instead of showing a stale login form', a.memoryUser === USERS.seller.id, JSON.stringify({ url: a.url, memory: a.memoryUser }));
    const cart = await p1.evaluate(() => localStorage.getItem('nextastore_cart_v1'));
    check("1b  the previous person's cart did not carry over", cart === null, `cart = ${cart}`);
    await ctx.close();

    // 1c: a tab that MISSED the storage event (frozen/discarded tab) gets a renewal
    // for its old token. It must not overwrite the newer session in storage.
    await freshState();
    ctx = await newContext(browser);
    p1 = await newPage(ctx, 'stale');
    await p1.addInitScript(() => { // this tab never hears about storage changes
        const orig = window.addEventListener;
        window.addEventListener = function (type, ...rest) { if (type === 'storage') return; return orig.call(this, type, ...rest); };
    });
    await uiLogin(p1, USERS.buyer, { remember: true, query: '?redirect=orders.html' });
    await advanceServer(16 * DAY); // buyer's remember-me token is now past half of its 30-day window
    p2 = await newPage(ctx, 'fresh');
    await p2.goto(`${BASE}/orders.html`); await sleep(300);
    await p2.evaluate(() => { app.endSession('logout'); });
    await uiLogin(p2, USERS.seller, { remember: true, query: '?redirect=orders.html' });
    const seller = await identity(p2);
    await ctl('clearlog');
    const stale = await p1.evaluate(async () => { try { await app.apiRequest('/user/me'); return 'ok'; } catch (e) { return `err ${e.code || e.message}`; } });
    await sleep(300);
    const log = (await serverLog()).filter((e) => e.path === '/user/me');
    const staleReq = log.find((e) => e.userId === USERS.buyer.id);
    const after = await identity(p2);
    check('1c  (precondition) the stale tab really was sent a renewed token', !!staleReq && staleReq.renewed === true, JSON.stringify({ stale, staleReq }));
    check("1c  the stale tab's renewal did NOT overwrite the newer person's token", after.tokenUser === USERS.seller.id && after.token === seller.token, `storage now belongs to ${after.tokenUser}`);
    await p1.reload(); await sleep(400);
    const reloaded = await identity(p1);
    check('1c  reloading the stale tab makes it the current person, not the old one', reloaded.memoryUser === USERS.seller.id, JSON.stringify({ memory: reloaded.memoryUser, token: reloaded.tokenUser }));
    await ctx.close();

    // 1d: the automatic user-profile refresh must not write an OLD person's record
    // beside a NEWER person's token when the session changed while it was in flight.
    await freshState();
    ctx = await newContext(browser);
    p1 = await newPage(ctx, 'stale');
    await p1.addInitScript(() => {
        const orig = window.addEventListener;
        window.addEventListener = function (type, ...rest) { if (type === 'storage') return; return orig.call(this, type, ...rest); };
    });
    await uiLogin(p1, USERS.buyer, { remember: true, query: '?redirect=orders.html' });
    p2 = await newPage(ctx, 'fresh');
    await p2.goto(`${BASE}/orders.html`); await sleep(300);
    await p2.evaluate(() => { app.endSession('logout'); });
    await uiLogin(p2, USERS.seller, { remember: true, query: '?redirect=orders.html' });
    await p1.evaluate(async () => { await app.loadUserData(); }); // what any stale tab's refresh does
    await sleep(300);
    const mix = await identity(p2);
    check('1d  a stale tab refreshing its profile does not leave storage holding a mismatched token/user pair', mix.tokenUser === mix.cachedUser, JSON.stringify({ token: mix.tokenUser, cachedUser: mix.cachedUser }));
    const next = await newPage(ctx, 'next');
    await next.goto(`${BASE}/orders.html`); await sleep(500);
    const n = await identity(next);
    check('1d  the next page opened is still signed in (not thrown out by the mismatch check)', n.hasToken && n.memoryUser === USERS.seller.id, JSON.stringify(n));
    await ctx.close();

    // 1e: routine renewal of the SAME person's token should not reload their other tabs
    await freshState();
    ctx = await newContext(browser);
    p1 = await newPage(ctx, 'p1');
    await uiLogin(p1, USERS.buyer, { remember: true, query: '?redirect=orders.html' });
    p2 = await newPage(ctx, 'p2');
    await p2.goto(`${BASE}/orders.html`); await sleep(400);
    await p2.evaluate(() => { window.__stillHere = true; });
    await advanceServer(16 * DAY);
    const before = (await identity(p1)).token;
    await p1.evaluate(async () => { await app.apiRequest('/user/me'); });
    await sleep(700);
    const renewedInStorage = (await identity(p1)).token !== before;
    const alive = await p2.evaluate(() => window.__stillHere === true).catch(() => false);
    check('1e  (precondition) a routine request in tab 1 renewed the shared token', renewedInStorage);
    check("1e  ...and tab 2 (same person) was NOT reloaded by it - an unsent message in tab 2 would survive", alive);
    const memberTok = await p2.evaluate(() => JSON.stringify({ mem: app.token === localStorage.getItem('nextastore_token') }));
    check('1e  tab 2 picked up the renewed token (its own requests use the latest one)', JSON.parse(memberTok).mem);
    await ctx.close();
}

// =============================================================================
// Scenario 2 - login page while already signed in (finding 3) + expiry redirect
// =============================================================================
async function s2(browser) {
    currentScenario = 's2';
    console.log('\nS2  Login page while signed in / redirect rules (findings 1 and 3)');
    await freshState();
    let ctx = await newContext(browser);
    let page = await newPage(ctx);
    // Watch what a person could actually SEE: is the login form ever the topmost
    // thing at its own position? (sessionStorage survives the same-tab redirect)
    await page.addInitScript(() => {
        const sample = () => {
            const f = document.getElementById('loginForm');
            if (f) {
                const r = f.getBoundingClientRect();
                const el = r.height > 0 ? document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height / 2, 40)) : null;
                if (el && f.contains(el)) sessionStorage.setItem('__loginFormSeen', '1');
            }
            requestAnimationFrame(sample);
        };
        document.addEventListener('DOMContentLoaded', () => requestAnimationFrame(sample));
    });
    await uiLogin(page, USERS.buyer, { remember: true, query: '?redirect=orders.html' });
    await page.evaluate(() => sessionStorage.removeItem('__loginFormSeen'));

    const cases = [
        ['login.html', /^\/marketplace\.html/, 'no ?redirect -> the role\'s home (buyer: marketplace)'],
        ['login.html?redirect=orders.html', /^\/orders\.html/, '?redirect=orders.html is honoured'],
        ['login.html?redirect=dashboard.html', /^\/marketplace\.html/, "a buyer's ?redirect=dashboard.html is ignored"],
        ['login.html?redirect=https%3A%2F%2Fevil.example', /^\/marketplace\.html/, 'an off-site ?redirect is ignored'],
        ['login.html?redirect=%2F%2Fevil.example', /^\/marketplace\.html/, 'a protocol-relative ?redirect is ignored'],
        ['login.html?redirect=orders.html&reason=expired', /^\/marketplace\.html/, 'an "expired" redirect is not handed to someone whose session did not just end'],
        ['signup.html', /^\/marketplace\.html/, 'signup.html also sends a signed-in visitor away']
    ];
    for (const [url, expected, label] of cases) {
        await page.goto(`${BASE}/${url}`);
        const ok = await waitUrl(page, expected, 5000);
        check(`2a  ${label}`, ok, `ended at ${(await identity(page)).url}`);
    }

    // Does the form flash while the destination is slow to arrive (mobile network)?
    await page.evaluate(() => sessionStorage.removeItem('__loginFormSeen'));
    await ctx.route('**/marketplace.html', async (route) => { await sleep(600); await route.continue(); });
    await page.goto(`${BASE}/login.html`);
    await waitUrl(page, /^\/marketplace\.html/, 8000);
    const seen = await page.evaluate(() => sessionStorage.getItem('__loginFormSeen'));
    check('2b  a signed-in visitor never sees the login form flash up while the redirect is loading (600ms latency)', seen !== '1');

    // Positive control: the sampler must be able to see the form when it IS on screen,
    // otherwise 2b above could pass for the wrong reason.
    const guest = await newContext(browser);
    const gp = await newPage(guest);
    await gp.addInitScript(() => {
        const sample = () => {
            const f = document.getElementById('loginForm');
            if (f) {
                const r = f.getBoundingClientRect();
                const el = r.height > 0 ? document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height / 2, 40)) : null;
                if (el && f.contains(el)) sessionStorage.setItem('__loginFormSeen', '1');
            }
            requestAnimationFrame(sample);
        };
        document.addEventListener('DOMContentLoaded', () => requestAnimationFrame(sample));
    });
    await gp.goto(`${BASE}/login.html`); await sleep(800);
    check('2b  (positive control) the same sampler DOES see the form for a signed-out visitor', (await gp.evaluate(() => sessionStorage.getItem('__loginFormSeen'))) === '1');
    await guest.close();
    await ctx.close();

    // 2c: end-to-end expiry -> login -> return (finding 1 regression check)
    await freshState();
    ctx = await newContext(browser);
    page = await newPage(ctx);
    await uiLogin(page, USERS.buyer, { remember: false, query: '?redirect=orders.html' }); // plain session: 2-day window
    // The browser clock is real here; expire the token by aging BOTH clocks.
    await page.evaluate(() => { // mark the stored token as expired without touching the server: rewrite exp
        const t = sessionStorage.getItem('nextastore_token');
        const [h, b, s] = t.split('.');
        const claims = JSON.parse(atob(b.replace(/-/g, '+').replace(/_/g, '/')));
        claims.exp = Math.floor(Date.now() / 1000) - 10;
        const nb = btoa(JSON.stringify(claims)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        sessionStorage.setItem('nextastore_token', `${h}.${nb}.${s}`);
    });
    await page.goto(`${BASE}/orders.html`);
    const toLogin = await waitUrl(page, /login\.html\?redirect=orders\.html&reason=expired/, 6000);
    check('2c  an expired session sends the person to login with the reason', toLogin, (await identity(page)).url);
    const notice = await page.textContent('#sessionNotice').catch(() => '');
    check('2c  the login page explains why', /expired/i.test(notice || ''), `notice = "${notice}"`);
    await page.fill('#email', USERS.seller.email); await page.fill('#password', USERS.seller.password);
    await Promise.all([waitLeftLogin(page), page.click('button[type="submit"]')]);
    check("2c  a DIFFERENT person signing in next is not dropped on the previous person's page", !/orders\.html/.test((await identity(page)).url), (await identity(page)).url);
    await ctx.close();

    await freshState();
    ctx = await newContext(browser);
    page = await newPage(ctx);
    await uiLogin(page, USERS.buyer, { remember: false, query: '?redirect=orders.html' });
    await page.evaluate(() => {
        const t = sessionStorage.getItem('nextastore_token'); const [h, b, s] = t.split('.');
        const c = JSON.parse(atob(b.replace(/-/g, '+').replace(/_/g, '/'))); c.exp = Math.floor(Date.now() / 1000) - 10;
        sessionStorage.setItem('nextastore_token', `${h}.${btoa(JSON.stringify(c)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}.${s}`);
    });
    await page.goto(`${BASE}/orders.html`);
    await waitUrl(page, /login\.html/, 6000);
    await page.fill('#email', USERS.buyer.email); await page.fill('#password', USERS.buyer.password);
    await Promise.all([waitLeftLogin(page), page.click('button[type="submit"]')]);
    check('2c  the SAME person signing back in IS returned to the page they were on', /orders\.html/.test((await identity(page)).url), (await identity(page)).url);
    await ctx.close();
}

// =============================================================================
// Scenario 3 - the 30-minute client idle timer
// =============================================================================
const hiddenInit = () => {
    window.__hidden = false;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.__hidden });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (window.__hidden ? 'hidden' : 'visible') });
};
const setHidden = (page, h) => page.evaluate((v) => { window.__hidden = v; document.dispatchEvent(new Event('visibilitychange')); }, h);
const signedIn = async (page) => { const i = await identity(page); return i.hasToken && !/login\.html/.test(i.url); };

async function s3(browser) {
    currentScenario = 's3';
    console.log('\nS3  30-minute idle timer (fake clock; server untouched)');

    async function fresh(opts = {}) {
        await freshState();
        const ctx = await newContext(browser, { clock: true });
        const page = await newPage(ctx);
        if (opts.hiddenControl) await page.addInitScript(hiddenInit);
        await uiLogin(page, USERS.buyer, { remember: true, query: '?redirect=orders.html' });
        return { ctx, page };
    }

    // 3a
    let { ctx, page } = await fresh();
    await ctx.clock.runFor(29 * MIN); await sleep(300);
    check('3a  still signed in after 29 minutes with no input', await signedIn(page));
    await ctx.clock.runFor(2 * MIN); await sleep(500);
    let id = await identity(page);
    check('3a  signed out after 31 minutes with no input', !id.hasToken, JSON.stringify({ url: id.url, hasToken: id.hasToken }));
    check('3a  ...and sent to login with reason=expired', /login\.html\?redirect=orders\.html&reason=expired/.test(id.url), id.url);
    await ctx.close();

    // 3b
    ({ ctx, page } = await fresh());
    await ctx.clock.runFor(20 * MIN); await page.keyboard.press('Shift');
    await ctx.clock.runFor(20 * MIN); await sleep(300);
    check('3b  a key press at minute 20 resets the clock (still signed in at minute 40)', await signedIn(page));
    await ctx.clock.runFor(11 * MIN); await sleep(500);
    check('3b  ...and it ends 30 minutes after that last input', !(await signedIn(page)));
    await ctx.close();

    // 3c
    ({ ctx, page } = await fresh({ hiddenControl: true }));
    await setHidden(page, true);
    await ctx.clock.runFor(2 * MIN); // a periodic check lands while the tab is in the background
    await setHidden(page, false);
    await ctx.clock.runFor(35 * MIN); await sleep(500);
    check('3c  a tab that was in the background for a moment still ends after 30+ idle minutes', !(await signedIn(page)), 'the idle timer stopped rescheduling itself after one check while hidden');
    await ctx.close();

    // 3d
    ({ ctx, page } = await fresh({ hiddenControl: true }));
    await setHidden(page, true);
    await ctx.clock.runFor(45 * MIN); await sleep(300);
    const stillDuringHidden = await signedIn(page);
    await setHidden(page, false); await sleep(100);
    await ctx.clock.runFor(2 * MIN); await sleep(500);
    check('3d  a tab hidden for 45 minutes is not signed out while hidden...', stillDuringHidden);
    check('3d  ...but is signed out once it becomes visible and has been idle past the limit', !(await signedIn(page)));
    await ctx.close();

    // 3e
    await freshState();
    ctx = await newContext(browser, { clock: true });
    const w1 = await newPage(ctx, 'idle-window'); const w2 = await newPage(ctx, 'active-window');
    await uiLogin(w1, USERS.buyer, { remember: true, query: '?redirect=orders.html' });
    await w2.goto(`${BASE}/orders.html`); await sleep(400);
    for (let i = 0; i < 5; i++) { await ctx.clock.runFor(10 * MIN); await w2.keyboard.press('Shift'); await w2.mouse.click(5, 5); await sleep(150); }
    await sleep(500);
    check('3e  working in one window keeps the SAME person signed in in their other window (50 min, window 1 untouched)', (await signedIn(w1)) && (await signedIn(w2)), JSON.stringify({ w1: (await identity(w1)).url, w2: (await identity(w2)).url }));
    await ctx.clock.runFor(29 * MIN); await sleep(300);
    check('3f  29 minutes after the last input in EITHER window, the person is still signed in', (await signedIn(w1)) || (await signedIn(w2)));
    await ctx.clock.runFor(3 * MIN); await sleep(700);
    check('3f  ~30 minutes after the last input in either window, both are signed out (the shared clock is not "never idle")', !(await signedIn(w1)) && !(await signedIn(w2)), JSON.stringify({ w1: (await identity(w1)).url, w2: (await identity(w2)).url }));
    await ctx.close();
}

// =============================================================================
// Scenario 4 - an open message thread must not keep a session alive
// =============================================================================
const POLL_PATHS = new Set(['/messages/conversations', '/messages/conversations/c1', '/messages/unread-count', '/notifications/unread-count']);
async function s4(browser) {
    currentScenario = 's4';
    console.log('\nS4  Open message thread vs. session renewal (finding 5)');
    await freshState();
    const ctx = await newContext(browser, { clock: true });
    const page = await newPage(ctx);
    await uiLogin(page, USERS.buyer, { remember: true, query: '?redirect=messages.html%3Fconversation%3Dc1' });
    await sleep(500);
    const open = await page.evaluate(() => ({ text: document.getElementById('threadMessages')?.textContent || '', since: window.messagesManager?.threadSince || null }));
    check('4   (precondition) the thread rendered and the incremental poll cursor is set', /Hello there/.test(open.text) && !!open.since, JSON.stringify({ text: open.text.slice(0, 40), since: open.since }));

    await advanceServer(16 * DAY);  // token is now past half of its 30-day window; only a REAL request may renew it
    await ctl('clearlog');
    const tokenBefore = (await identity(page)).token;
    await ctx.clock.runFor(70 * 1000); await sleep(600); // ~8 thread polls, ~3 badge refreshes
    let log = await serverLog();
    const polls = log.filter((e) => POLL_PATHS.has(e.path));
    const renewedByPoll = polls.filter((e) => e.renewed);
    const noHeader = polls.filter((e) => !e.bg);
    check('4a  (precondition) polls really ran', polls.length >= 8, `only ${polls.length} poll requests seen`);
    check('4a  every poll request carries X-Background-Poll', noHeader.length === 0, `${noHeader.length} without header, e.g. ${JSON.stringify(noHeader[0])}`);
    check('4a  no poll response renewed the session', renewedByPoll.length === 0, `${renewedByPoll.length} renewed`);
    check("4a  the browser's stored token did not change while only polling", (await identity(page)).token === tokenBefore);

    await ctl('clearlog');
    await page.evaluate(async () => { await app.apiRequest('/user/me'); });
    await sleep(300);
    const real = (await serverLog()).find((e) => e.path === '/user/me');
    check('4b  (positive control) a real request past the halfway mark DOES renew - so 4a is not passing vacuously', !!real && real.renewed === true, JSON.stringify(real));

    // The one poll-driven request that is not a background request: the
    // "cursor lost / gap too big" fallback re-opens the whole thread.
    await advanceServer(16 * DAY);
    await ctl('flag?name=truncateThread&value=1');
    await ctl('clearlog');
    const tokenB4 = (await identity(page)).token;
    await ctx.clock.runFor(20 * 1000); await sleep(600);
    log = await serverLog();
    const fallbackReqs = log.filter((e) => e.path === '/messages/conversations/c1' && !e.query.includes('since='));
    const renewedByFallback = log.filter((e) => e.renewed && e.path === '/messages/conversations/c1');
    check('4c  (precondition) the fallback re-open was triggered by a poll', fallbackReqs.length > 0, 'no full-thread reload seen');
    check('4c  the poll fallback (full thread reload) does not renew the session either', renewedByFallback.length === 0 && (await identity(page)).token === tokenB4, `${renewedByFallback.length} renewals`);
    await ctl('flag?name=truncateThread&value=0');

    // Session must still die on the SERVER's schedule with only polling going on.
    await advanceServer(31 * DAY);
    await ctx.clock.runFor(40 * 1000); await sleep(800);
    const end = await identity(page);
    check('4d  after the token\'s own lifetime, polling alone gets the tab signed out (401 -> login?reason=expired)', !end.hasToken && /login\.html/.test(end.url) && /reason=expired/.test(end.url), JSON.stringify({ url: end.url, hasToken: end.hasToken }));
    await ctx.close();
}

// =============================================================================
// Scenario 5 - "log out of all devices" reaches other devices
// =============================================================================
async function s5(browser) {
    currentScenario = 's5';
    console.log('\nS5  Log out of all devices (finding 6) - two separate browsers');
    await freshState();
    const deviceA = await newContext(browser); const deviceB = await newContext(browser);
    const a = await newPage(deviceA, 'A'); const b = await newPage(deviceB, 'B');
    await uiLogin(a, USERS.buyer, { remember: false, query: '?redirect=orders.html' });
    await uiLogin(b, USERS.buyer, { remember: false, query: '?redirect=orders.html' });
    check('5   (precondition) both devices are signed in as the same person', (await identity(a)).memoryUser === USERS.buyer.id && (await identity(b)).memoryUser === USERS.buyer.id);

    // exactly what the dashboard button does after its confirm dialog
    await a.evaluate(async () => { try { await app.apiRequest('/auth/logout-all', { method: 'POST' }); } catch (e) { /* the button ignores this */ } app.endSession('logout'); window.location.href = 'login.html'; });
    await waitUrl(a, /login\.html/, 5000);
    check('5a  device A is signed out itself', !(await identity(a)).hasToken);
    check('5a  the server bumped tokenVersion', (await (await fetch(`${BASE}/__test/user?id=${USERS.buyer.id}`)).json()).tokenVersion === 1);

    await ctl('clearlog');
    const out = await b.evaluate(async () => { try { await app.apiRequest('/user/me'); return 'ok'; } catch (e) { return `${e.status} ${e.code}`; } });
    check("5b  device B's very next request is refused with 401 TOKEN_REVOKED", out === '401 TOKEN_REVOKED', out);
    const landed = await waitUrl(b, /login\.html\?redirect=orders\.html&reason=revoked/, 5000);
    check('5b  device B is sent to login with reason=revoked and its session is cleared', landed && !(await identity(b)).hasToken, (await identity(b)).url);
    const notice = await b.textContent('#sessionNotice').catch(() => '');
    check('5b  the login page tells device B why', /sessions were ended|password changed/i.test(notice || ''), `notice = "${notice}"`);

    await b.fill('#email', USERS.buyer.email); await b.fill('#password', USERS.buyer.password);
    await Promise.all([waitLeftLogin(b), b.click('button[type="submit"]')]);
    check('5c  signing in again on device B works (a new token carries the new version)', (await identity(b)).hasToken && /orders\.html/.test((await identity(b)).url), (await identity(b)).url);
    await deviceA.close(); await deviceB.close();
}

// =============================================================================
const SCENARIOS = { s1, s2, s3, s4, s5 };
(async () => {
    const wanted = process.argv.slice(2).filter((a) => SCENARIOS[a]);
    const names = wanted.length ? wanted : Object.keys(SCENARIOS);
    const harness = await start(PORT);
    const browser = await chromium.launch();
    console.log(`Chromium ${browser.version()} | policies: session ${harness.policies.session.ttlSeconds / DAY}d/${harness.policies.session.maxAgeSeconds / DAY}d, remember ${harness.policies.remember.ttlSeconds / DAY}d/${harness.policies.remember.maxAgeSeconds / DAY}d`);
    try {
        for (const n of names) { try { await SCENARIOS[n](browser); } catch (e) { check(`${n} crashed: ${e.message.split('\n')[0]}`, false, e.stack.split('\n').slice(1, 3).join(' | ')); } }
    } finally {
        await browser.close(); await harness.close();
    }
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    if (failed.length) { console.log('\nFAILED:'); failed.forEach((f) => console.log(`  [${f.scenario}] ${f.name}${f.detail ? `\n         -> ${f.detail}` : ''}`)); }
    if (pageErrors.length) { console.log(`\nUncaught page errors (${pageErrors.length}, first 5):`); [...new Set(pageErrors)].slice(0, 5).forEach((e) => console.log('  ' + e)); }
    process.exit(failed.length ? 1 : 0);
})();
