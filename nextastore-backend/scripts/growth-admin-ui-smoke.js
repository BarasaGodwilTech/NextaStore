/**
 * WIP 113: smoke test for the admin console script (js/admin-growth.js) with NO browser.
 * It runs the real script against a tiny fake page, serving every API call from the REAL admin backend on the in-memory database,
 * then visits every page and opens a partner's file. It catches what a syntax check cannot: a wrong field name between screen and
 * server, a helper that was never defined, a template that throws on real data.
 * It does NOT check how anything looks. Run:  node scripts/growth-admin-ui-smoke.js
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
const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms));
const unhandled = []; process.on('unhandledRejection', (e) => unhandled.push(e));

// ---- the real backend
const clock = () => new Date('2026-10-12T07:00:00Z');
const prisma = createMemoryPrisma(clock);
const growth = createGrowth({ prisma, now: clock, createNotification: async () => {}, recordAdminAudit: async () => {} });
const db = prisma._db;
const mk = (id, name, extra = {}) => { const u = { id, name, email: `${id}@gmail.test`, role: 'buyer', accountStatus: 'active', emailVerifiedAt: clock(), createdAt: clock(), ...extra }; db.user.push(u); return u; };

// ---- the public rules payload (what GET /growth/rules answers)
function rulesPayload() {
    const routesMod = (() => { const o = Module._load; Module._load = function (r, ...a) { return r === 'express' ? { Router: () => { const x = { routes: {} }; ['get', 'post', 'put', 'delete'].forEach((m) => { x[m] = (p, ...h) => { x.routes[`${m} ${p}`] = h; return x; }; }); return x; } } : o.call(this, r, ...a); }; try { return require(path.join(__dirname, '..', 'src', 'growth', 'routes.js')); } finally { Module._load = o; } })();
    const { createHosts } = require(path.join(__dirname, '..', 'src', 'growth', 'hosts.js'));
    const o = Module._load; Module._load = function (r, ...a) { return r === 'express' ? { Router: () => { const x = { routes: {} }; ['get', 'post', 'put', 'delete'].forEach((m) => { x[m] = (p, ...h) => { x.routes[`${m} ${p}`] = h; return x; }; }); return x; } } : o.call(this, r, ...a); };
    let built; try { built = routesMod.buildRoutes({ partners: {}, hooks: {}, leads: {}, withdrawals: {}, admin: {}, ctx: { getSettings: async () => ({ circleOpen: true, crewOpen: true }), hosts: createHosts({}), prisma: {} } }, { requireAuth: (q, s, n) => n(), requireAdminPermission: () => (q, s, n) => n() }); } finally { Module._load = o; }
    return new Promise((resolve) => built.partner.routes['get /rules'].slice(-1)[0]({}, { setHeader() {}, json: (b) => resolve(b.data) }, (e) => { throw e; }));
}

// ---- a tiny fake page
const el = (init = {}) => {
    const self = { innerHTML: '', textContent: '', value: '10', checked: false, hidden: false, dataset: {}, style: {}, children: [], _h: {}, ...init };
    self.classList = { add() {}, remove() {}, toggle() {}, contains: () => false };
    self.addEventListener = (t, f) => { (self._h[t] = self._h[t] || []).push(f); };
    self.querySelector = () => el(); self.querySelectorAll = () => []; self.closest = () => null;
    self.setAttribute = () => {}; self.removeAttribute = () => {}; self.focus = () => {}; self.remove = () => {}; self.appendChild = () => {}; self.close = () => {}; self.scrollIntoView = () => {};
    return self;
};

(async () => {
    const rules = await rulesPayload();
    const ann = mk('u_ann', 'Ann Circle'), kofi = mk('u_kofi', 'Kofi Crew'), una = mk('u_una', 'Una Waiting');
    const pa = await growth.partners.joinCircle(ann, { phone: '0772000111', agreedTerms: true, ip: '10.0.0.1' });
    await growth.partners.setPayout(ann, { network: 'mtnMomo', number: '0772000111', name: 'Ann' });
    const pk = await growth.partners.applyCrew(kofi, { phone: '0754000222', territories: ['kampala'], kycFileUrl: 'private/k.jpg', cardPhotoUrl: 'private/card.jpg', agreedTerms: true, ip: '10.0.0.2' });
    await growth.admin.approveCrew('adm1', pk.id);
    await growth.partners.applyCrew(una, { phone: '0754000333', territories: ['wakiso'], kycFileUrl: 'private/u.jpg', cardPhotoUrl: 'private/card.jpg', agreedTerms: true, ip: '10.0.0.3' });
    await growth.admin.addNote('adm1', pa.id, 'Smoke test note');

    const admin = growth.admin;
    const parseQs = (q) => Object.fromEntries(new URLSearchParams(q || ''));
    const calls = [];
    const serve = async (full) => {
        const [p, qs] = full.split('?'); const q = parseQs(qs); calls.push(p);
        if (p === '/growth/rules') return rules;
        const a = p.replace('/admin/growth', '');
        if (a === '/segments') return admin.segments();
        if (a === '/overview') return admin.overview();
        if (a === '/economics') return admin.economics();
        if (a === '/economics/model') return admin.economicsModel();
        if (a === '/members') return admin.members(q);
        if (a === '/security') return admin.securityScan();
        if (a === '/audit') return admin.auditFeed(q);
        if (a === '/lookup') return admin.lookup(q.q);
        if (a === '/campaigns') return admin.listCampaigns();
        if (a === '/settings') return admin.getSettings();
        if (a === '/flags') return admin.listFlags(q);
        if (a === '/review-queue') return admin.reviewQueue();
        if (a === '/withdrawals') return growth.withdrawals.queue(q);
        if (a === '/upgrades') return growth.upgrades.list(q);   // Circle members asking to move up to Crew
        let m = /^\/partners\/([^/]+)\/diagnose$/.exec(a); if (m) return admin.diagnose(m[1]);
        m = /^\/partners\/([^/]+)\/timeline$/.exec(a); if (m) return admin.timeline(m[1]);
        m = /^\/partners\/([^/]+)$/.exec(a); if (m) return admin.partnerDetail(m[1]);
        throw Object.assign(new Error(`smoke: no stand-in for ${p}`), { status: 404 });
    };

    const rootEl = el(); const elements = { agRoot: rootEl };
    const hashHandlers = [];
    const win = {
        addEventListener: (t, f) => { if (t === 'hashchange') hashHandlers.push(f); }, scrollTo() {}, scrollY: 0,
        GrowthEconomics: require(path.join(ROOT, 'js', 'growth-economics.js')),
        GrowthUI: {
            esc: (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
            ugx: (n) => `UGX ${Math.round(Number(n) || 0).toLocaleString('en-UG')}`, when: (d) => String(d || ''), day: (d) => String(d || ''),
            titleCase: (s) => String(s || '').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()), toast() {}, busy: (b, fn) => fn(),
            dialog: () => { const d = el(); d.querySelector = () => el(); return d; }, confirm: async () => true, prompt: async () => 'a reason that is long enough'
        }
    };
    const location = { hash: '#overview' };
    const sandbox = {
        window: win, document: { getElementById: (id) => elements[id] || (elements[id] = el()), querySelector: () => null, querySelectorAll: () => [], createElement: () => el(), body: el() },
        location, sessionStorage: { getItem: () => null, setItem() {} }, localStorage: { getItem: () => 't', setItem() {} }, setTimeout, console, URLSearchParams, URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} }, Promise, Date, Number, String, Math, JSON, Set, Map, Object, Array, encodeURIComponent, Date,
        app: { apiBaseUrl: '/api', apiRequest: async (p) => ({ data: await serve(p) }) }, fetch: async () => ({ ok: false, json: async () => ({ message: 'no' }) })
    };
    sandbox.window.location = location; sandbox.window.document = sandbox.document;
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', 'admin-growth.js'), 'utf8'), sandbox, { filename: 'admin-growth.js' });

    const visit = async (hash) => { location.hash = hash; hashHandlers.forEach((f) => f()); await tick(80); return rootEl.innerHTML; };
    let h = await tick(120) || rootEl.innerHTML;
    check('Overview renders on load, with both programs and the cost guard', /Overview/.test(h) && /Circle/.test(h) && /Crew/.test(h) && /Is it worth it/.test(h), h.slice(0, 160));
    check('Overview shows the waiting Crew application as something to do today', /Crew application/.test(h) && /to decide/.test(h));

    const pages = [['#members', /Members/, 'a real member row', /Ann Circle/], ['#applications', /Applications[\s\S]*Circle members asking to move up[\s\S]*New Crew applicants/, 'the upgrade-request section and the waiting applicant with her checklist', /Una Waiting[\s\S]*ID photo on file/],
        ['#money', /Payout queue|Money/, 'the money page', /Money/], ['#money/owed', /What we owe partners/, 'the liabilities table', /Earned, not yet paid/],
        ['#money/economics', /Is it worth it\? Try your own numbers/, 'the calculator and the scenario table', /What each reward buys/], ['#risk', /Risk/, 'the review queue', /Risk/],
        ['#risk/flags', /Risk/, 'flags', /Risk/], ['#risk/scan', /Duplicate and self-dealing scan/, 'the scan', /partners checked/], ['#tools', /Find anything/, 'search form', /Find anything/],
        ['#tools/export', /Exports/, 'the export buttons', /data-export="withdrawals"/], ['#tools/audit', /Audit trail/, 'the audit trail', /Audit trail/], ['#campaigns', /Campaigns and settings/, 'campaigns', /Campaigns and settings/]];
    for (const [hash, re, what, re2] of pages) {
        const out = await visit(hash);
        check(`${hash}: renders ${what}`, !/Cannot show this/.test(out) && re.test(out) && re2.test(out), /Cannot show this[\s\S]{0,200}/.exec(out)?.[0] || out.slice(0, 140));
    }
    await visit('#tools/audit');
    check('the audit trail lists the note the admin wrote', /Partner note/.test(rootEl.innerHTML) || /No recorded actions yet/.test(rootEl.innerHTML));

    // members: scope switch and filters flow through the click delegation
    const click = rootEl._h.click || [];
    const press = async (sel, dataset) => { const target = { closest: (s) => (s === sel ? { dataset, disabled: false } : null) }; for (const f of click) f({ target, preventDefault() {} }); await tick(80); };
    await visit('#members');
    await press('[data-scope]', { scope: 'crew' });
    check('switching to Crew shows only Crew members', /Kofi Crew/.test(rootEl.innerHTML) && !/Ann Circle/.test(rootEl.innerHTML), rootEl.innerHTML.slice(0, 100));
    await press('[data-scope]', { scope: 'circle' });
    check('and Circle only', /Ann Circle/.test(rootEl.innerHTML) && !/Kofi Crew/.test(rootEl.innerHTML));
    await press('[data-scope]', { scope: 'all' });

    // the partner file
    const errs0 = unhandled.length;
    await press('[data-detail]', { detail: pa.id });
    check('opening a partner file loads detail, the diagnosis and the history without errors', unhandled.length === errs0, unhandled.slice(errs0).map((e) => e && e.stack || e).join(' | ').slice(0, 300));
    check('the console asked the server for exactly the three things the file needs', ['/admin/growth/partners/' + pa.id, '/admin/growth/partners/' + pa.id + '/diagnose', '/admin/growth/partners/' + pa.id + '/timeline'].every((c) => calls.includes(c)));
    await press('[data-detail]', { detail: pk.id });
    check('and a Crew member\'s file', unhandled.length === errs0);

    const bad = calls.filter((c) => /undefined|\[object/.test(c));
    check('no request was ever built with "undefined" or "[object" in it', bad.length === 0, bad.join(','));
    check('no unhandled errors anywhere in the run', unhandled.length === 0, unhandled.map((e) => e && e.stack || e).join(' | ').slice(0, 400));
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
