/**
 * WIP 113: smoke test for the Circle / Crew member app (js/growth.js + growth-shell.js + growth-art.js + growth-hosts.js), NO browser.
 * It runs the real scripts against a tiny fake page and serves every API call from the REAL growth backend on the in-memory database,
 * for each state a person can be in: not signed up, blocked (email), joined, waiting for approval, approved, in the other program.
 * It catches wrong field names between screen and server, undefined helpers and templates that throw on real data.
 * It does NOT check how anything looks. Run:  node scripts/growth-app-smoke.js
 */
'use strict';
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const Module = require('module');
const ROOT = path.join(__dirname, '..', '..');
const { createGrowth } = require(path.join(__dirname, '..', 'src', 'growth', 'index.js'));
const { createMemoryPrisma } = require('./lib/memory-prisma');

let passed = 0, failed = 0;
const check = (n, ok, x) => { if (ok) { passed += 1; console.log('  ok   ' + n); } else { failed += 1; console.log('  FAIL ' + n + (x ? ' -> ' + x : '')); } };
const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));
const unhandled = []; process.on('unhandledRejection', (e) => unhandled.push(e));

const clock = () => new Date('2026-10-12T07:00:00Z');
const prisma = createMemoryPrisma(clock);
const growth = createGrowth({ prisma, now: clock, createNotification: async () => {}, recordAdminAudit: async () => {} });
const db = prisma._db;
const mk = (id, name, extra = {}) => { const u = { id, name, email: `${id}@gmail.test`, role: 'buyer', accountStatus: 'active', emailVerifiedAt: clock(), createdAt: clock(), ...extra }; db.user.push(u); return u; };

// ---- the real route table, served without Express
const routes = (() => {
    const o = Module._load;
    Module._load = function (r, ...a) { return r === 'express' ? { Router: () => { const x = { routes: {} }; ['get', 'post', 'put', 'delete'].forEach((m) => { x[m] = (p, ...h) => { x.routes[`${m} ${p}`] = h; return x; }; }); return x; } } : o.call(this, r, ...a); };
    try { return growth.routes({ requireAuth: (q, s, n) => n(), requireAdminPermission: () => (q, s, n) => n() }); } finally { Module._load = o; }
})();
async function serve(user, method, full, body) {
    const [p, qs] = full.split('?'); const query = Object.fromEntries(new URLSearchParams(qs || ''));
    const path_ = p.replace(/^\/growth/, '');
    for (const [key, chain] of Object.entries(routes.partner.routes)) {
        const [m, pattern] = key.split(' '); if (m !== String(method).toLowerCase()) continue;
        const names = []; const re = new RegExp('^' + pattern.replace(/:([a-zA-Z]+)/g, (_, n) => { names.push(n); return '([^/]+)'; }) + '$');
        const hit = re.exec(path_); if (!hit) continue;
        const params = Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(hit[i + 1])]));
        return new Promise((resolve, reject) => {
            const res = { setHeader() {}, status() { return this; }, json: (b) => resolve(b) };
            chain[chain.length - 1]({ user, params, query, body: body || {}, headers: {}, ip: '10.0.0.9' }, res, (err) => reject(Object.assign(err, { code: err.code })));
        });
    }
    throw Object.assign(new Error(`smoke: no route for ${method} ${full}`), { status: 404 });
}

const el = (init = {}) => {
    const self = { innerHTML: '', textContent: '', value: '', checked: false, hidden: false, dataset: {}, style: {}, _h: {}, files: [], ...init };
    self.classList = { add() {}, remove() {}, toggle() {}, contains: () => false };
    self.addEventListener = (t, f) => { (self._h[t] = self._h[t] || []).push(f); };
    self.querySelector = () => el(); self.querySelectorAll = () => []; self.closest = () => null; self.insertAdjacentHTML = () => {};
    self.setAttribute = () => {}; self.removeAttribute = () => {}; self.focus = () => {}; self.remove = () => {}; self.appendChild = () => {}; self.close = () => {}; self.scrollIntoView = () => {};
    return self;
};

async function visit({ program, user, search = '', hash = '', hostsConfig }) {
    const elements = {}; const redirects = []; const toasts = [];
    const body = el({ dataset: { program } }); body.getAttribute = (k) => (k === 'data-program' ? program : null); body.classList = { _on: new Set(), add(c) { this._on.add(c); }, remove(c) { this._on.delete(c); }, toggle() {}, contains(c) { return this._on.has(c); } };
    const document = { body, getElementById: (id) => elements[id] || (elements[id] = el()), querySelector: () => null, querySelectorAll: () => [], createElement: () => el(), addEventListener() {}, documentElement: el(), hidden: false };
    const location = { search, hash, pathname: '/' + (program === 'crew' ? 'crew' : 'circle'), origin: 'http://localhost:4000', host: 'localhost:4000', hostname: 'localhost', protocol: 'http:', replace: (u) => redirects.push(u), href: '' };
    const win = { document, location, addEventListener() {}, scrollTo() {}, history: { replaceState() {} }, open() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) };
    const ui = { esc: (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])), ugx: (n) => `UGX ${Math.round(Number(n) || 0).toLocaleString('en-UG')}`, when: (d) => String(d || ''), day: (d) => String(d || ''),
        titleCase: (s) => String(s || '').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()), toast: (m) => toasts.push(m), busy: (b, fn) => fn(), dialog: () => el(), confirm: async () => true, prompt: async () => 'x', keepScroll: (f) => f(), offlineBanner() {}, registerWorker() {} };
    win.GrowthUI = ui;
    const sandbox = { window: win, document, location, history: win.history, navigator: { clipboard: { writeText: async () => {} } }, localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, sessionStorage: { getItem: () => null, setItem() {} },
        console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}, Promise, Date, Number, String, Math, JSON, Set, Map, Object, Array, URL, URLSearchParams, encodeURIComponent, decodeURIComponent, Intl, RegExp, Error, isFinite, parseInt, parseFloat, FileReader: function () {}, Event: function () {},
        app: { user, apiBaseUrl: '/api', apiRequest: async (p, o) => ({ data: (await serve(user, (o && o.method) || 'GET', p, o && o.body ? JSON.parse(o.body) : undefined)).data }), renderAccountNavs() { sandbox.__navs += 1; }, logout() {}, showAlert() {} }, __navs: 0 };
    win.window = win; vm.createContext(sandbox);
    const load = (f) => vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', f), 'utf8'), sandbox, { filename: f });
    sandbox.NextaHosts = undefined;
    for (const f of ['growth-hosts.js', 'growth-shell.js', 'growth-art.js']) load(f);
    // the UMD files attach to the window they are given; give the page-level names too
    for (const k of ['NextaHosts', 'GrowthShell', 'GrowthArt', 'GrowthEconomics']) if (win[k]) sandbox[k] = win[k];
    load('growth.js');
    await tick(150);
    // the join card is filled in separately (after the eligibility answer arrives), so read it too
    return { html: (elements.gpRoot ? elements.gpRoot.innerHTML : '') + (elements.gpJoinCard ? elements.gpJoinCard.innerHTML : ''), redirects, toasts, body, top: elements.gpTopNav, bar: elements.gpTabbar, navs: sandbox.__navs, sandbox };
}
const clean = (html) => !/undefined|NaN|\[object|null</.test(html.replace(/data-[a-z-]+="[^"]*"/g, ''));

(async () => {
    // ---------- a person who has not joined
    const dina = mk('u_dina', 'Dina Auma');
    let v = await visit({ program: 'circle', user: dina });
    check('Circle, not a member: the pitch, then the join card with its requirements checklist', /Bring a store into your circle/.test(v.html) && /gp-reqs/.test(v.html) && /id="gpJoin"/.test(v.html), v.html.slice(0, 200));
    check('the checklist shows every layer as passed for a verified account', (v.html.match(/class="is-ok"/g) || []).length === 4 && !/is-bad/.test(v.html));
    check('step 1 asks for the phone number, and the terms are not asked for yet', /id="gpPhone"/.test(v.html) && /data-step="phone"/.test(v.html) && /data-step="agree"/.test(v.html));
    check('no tab bar for someone who has not joined, just the About / NextaStore links', v.bar && v.bar.hidden === true && /About Circle/.test(v.top.innerHTML) && !v.body.classList.contains('has-tabbar'));
    check('everything printed is free of "undefined", "NaN" and "[object"', clean(v.html));

    // ---------- blocked: unverified email
    const una = mk('u_una', 'Una Unverified', { emailVerifiedAt: null });
    v = await visit({ program: 'circle', user: una });
    check('an unverified email gets the checklist with the fix and a button to send the email, and NO form', /is-bad/.test(v.html) && /verification email/.test(v.html) && /id="gpSendVerify"/.test(v.html) && !/id="gpJoin"/.test(v.html), v.html.slice(0, 300));

    // ---------- joined: the dashboard
    const pd = await growth.partners.joinCircle(dina, { phone: '0772123456', agreedTerms: true, ip: '10.0.0.5' });
    v = await visit({ program: 'circle', user: dina });
    const panels = [...v.html.matchAll(/data-panel="([a-z]+)"/g)].map((m) => m[1]);
    check('Circle dashboard has the five sections in order', panels.join() === 'home,recruits,earn,share,more', panels.join());
    check('the Home section carries the hero, a Get started checklist and the tiles', /gp-hero/.test(v.html) && /Get started/.test(v.html) && /gp-stats/.test(v.html));
    check('the Get started card starts with the payout number (nothing is done yet) and shows a progress ring', /Add your payout number/.test(v.html) && /role="img"/.test(v.html) && /0 of 5 done/.test(v.html));
    check('the other sections exist in the page (hidden), so every button keeps working', /id="gpWithdraw"/.test(v.html) && /id="gpStudio"/.test(v.html) && /id="gpClaimBtn"/.test(v.html) && /id="gpLogout"/.test(v.html));
    check('the bottom bar and header tabs are drawn and the page is marked as having a tab bar', v.bar.hidden === false && /data-tab="earn"/.test(v.bar.innerHTML) && v.body.classList.contains('has-tabbar'));
    check('the header menu was redrawn once the member was known', v.navs >= 1);
    check('the withdrawal explains itself instead of failing on submit', /gp-why/.test(v.html) && /payout number|smallest withdrawal|first withdrawal/i.test(v.html));
    check('the More tab has account facts, the way back to NextaStore and the About link', /Your account/.test(v.html) && /Back to NextaStore/.test(v.html) && /about-circle/.test(v.html));
    check('no stray placeholders in the dashboard', clean(v.html));
    v = await visit({ program: 'circle', user: dina, hash: '#share' });
    check('a deep link to #share opens that section', /data-panel="share" tabindex="-1">/.test(v.html) && !/data-panel="share"[^>]*hidden/.test(v.html), v.html.match(/data-panel="share"[^>]*>/)?.[0]);
    v = await visit({ program: 'circle', user: dina, hash: '#field' });
    check('a hash from the other program falls back to Home', /data-panel="home" tabindex="-1">/.test(v.html));

    // ---------- the other program's page
    // Changed on purpose (WIP 115): a Circle member on the Crew page is here to ask to move up, so they are NOT sent away.
    v = await visit({ program: 'crew', user: dina });
    check('a Circle member opening the Crew page stays there and sees the upgrade form (not a "wrong program" redirect)', v.redirects.length === 0 && /Ask to move up to the Crew/.test(v.html) && /id="gpApply"/.test(v.html) && /Ready to do more/.test(v.html), JSON.stringify(v.redirects));
    check('the page promises what the money rule promises: Circle keeps working, earlier stores stay on Circle terms', /keeps working/.test(v.html) && /stay on Circle terms/.test(v.html) && /new Crew code/.test(v.html));
    check('the button says it continues a request to move up, not a new application', /Continue to my request/.test(v.html) && !/Start my application/.test(v.html));
    // The reverse is unchanged: a Crew member on the Circle page is sent to their own dashboard, with a note why.
    const vera = mk('u_vera', 'Vera Crew');
    const vp = await growth.partners.applyCrew(vera, { phone: '0754222000', territories: ['kampala'], kycFileUrl: 'private/v.jpg', cardPhotoUrl: 'private/card.jpg', agreedTerms: true, ip: '10.0.0.8' });
    await growth.admin.approveCrew('adm1', vp.id);
    v = await visit({ program: 'circle', user: vera });
    check('a Crew member opening the Circle page is sent to their own dashboard, with a note why', v.redirects.length === 1 && /\/crew\?wrong=1$/.test(v.redirects[0]), JSON.stringify(v.redirects));
    // Someone who MOVED UP from Circle and opens their old Circle bookmark is taken to Crew quietly: nothing looks broken.
    const ugo = mk('u_ugo', 'Ugo Upgraded');
    await growth.partners.joinCircle(ugo, { phone: '0754333000', agreedTerms: true, ip: '10.0.0.9' });
    await growth.partners.applyUpgrade(ugo, { phone: '0754333111', territories: ['kampala'], kycFileUrl: 'private/u.jpg', cardPhotoUrl: 'private/card.jpg', agreedTerms: true, ip: '10.0.0.9' });
    const uq = (await growth.upgrades.list({}))[0];
    await growth.upgrades.approve('adm1', uq.id);
    v = await visit({ program: 'circle', user: ugo });
    check('an upgraded member opening their OLD Circle page is taken to Crew quietly (no "wrong program" note)', v.redirects.length === 1 && /\/crew$/.test(v.redirects[0]) && !/wrong/.test(v.redirects[0]), JSON.stringify(v.redirects));
    v = await visit({ program: 'crew', user: ugo });
    check('and their Crew dashboard welcomes them and says the old link still works', /Welcome to the Crew/.test(v.html) && /still work/.test(v.html), v.html.slice(0, 200));

    // ---------- Crew: join, waiting, approved
    const kofi = mk('u_kofi', 'Kofi Mensah');
    v = await visit({ program: 'crew', user: kofi });
    check('Crew, not a member: the page lists the steps (details and ID, card photo, areas, review), has the Start button, and the review promise is the application one', /Apply to join the Crew/.test(v.html) && /Start my application/.test(v.html) && /id="gpApply"/.test(v.html) && /ID, front and back/.test(v.html) && /Crew ID card/.test(v.html) && /areas where you will work/.test(v.html) && /within 2 working days/.test(v.html));
    const pk = await growth.partners.applyCrew(kofi, { phone: '0754111000', territories: ['kampala', 'wakiso'], kycFileUrl: 'private/k.jpg', cardPhotoUrl: 'private/card.jpg', agreedTerms: true, ip: '10.0.0.6' });
    v = await visit({ program: 'crew', user: kofi });
    check('a waiting applicant sees the waiting screen with the real review time and no tab bar', /reviewing your application/i.test(v.html) && /within 2 working days/.test(v.html) && !/usually takes up to/.test(v.html) && v.bar.hidden === true);
    await growth.admin.approveCrew('adm1', pk.id);
    v = await visit({ program: 'crew', user: kofi });
    const cpanels = [...v.html.matchAll(/data-panel="([a-z]+)"/g)].map((m) => m[1]);
    check('an approved Crew member gets Home, Field, Stores, Earnings and More', cpanels.join() === 'home,field,recruits,earn,more', cpanels.join());
    check('the Crew Home has the rank card with a medal, the Field tab has the lead form', /Your rank/.test(v.html) && /gp-rank-badge is-medal/.test(v.html) && /aria-label="Trailhead medal"/.test(v.html) && /id="gpLead"/.test(v.html));
    check('the Crew QR button is in the hero', /id="gpQr"/.test(v.html));
    check('the Crew dashboard prints nothing undefined', clean(v.html));
    v = await visit({ program: 'circle', user: kofi });
    check('a Crew member opening the Circle page is sent to Crew', v.redirects.length === 1 && /\/crew\?wrong=1$/.test(v.redirects[0]), JSON.stringify(v.redirects));

    console.log(`\n${passed} passed, ${failed} failed`);
    check('no unhandled errors anywhere', unhandled.length === 0, unhandled.map((e) => (e && e.stack) || e).join(' | ').slice(0, 500));
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
