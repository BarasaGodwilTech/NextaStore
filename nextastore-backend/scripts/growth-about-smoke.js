/**
 * WIP 113: runs the About-page script (js/growth-about.js) end to end against a fake page and the REAL rules payload and membership,
 * for a signed-out visitor, a member of this program, and a member of the other program. No browser. Does not check how it looks.
 * Run:  node scripts/growth-about-smoke.js
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
const tick = (ms = 80) => new Promise((r) => setTimeout(r, ms));
const unhandled = []; process.on('unhandledRejection', (e) => unhandled.push(e));

const clock = () => new Date('2026-10-12T07:00:00Z');
const prisma = createMemoryPrisma(clock);
const growth = createGrowth({ prisma, now: clock, createNotification: async () => {}, recordAdminAudit: async () => {} });
const mk = (id, name) => { const u = { id, name, email: `${id}@gmail.test`, role: 'buyer', accountStatus: 'active', emailVerifiedAt: clock(), createdAt: clock() }; prisma._db.user.push(u); return u; };
const routes = (() => { const o = Module._load; Module._load = function (r, ...a) { return r === 'express' ? { Router: () => { const x = { routes: {} }; ['get', 'post', 'put', 'delete'].forEach((m) => { x[m] = (p, ...h) => { x.routes[`${m} ${p}`] = h; return x; }; }); return x; } } : o.call(this, r, ...a); }; try { return growth.routes({ requireAuth: (q, s, n) => n(), requireAdminPermission: () => (q, s, n) => n() }); } finally { Module._load = o; } })();
const call = (key, user) => new Promise((resolve, reject) => { const chain = routes.partner.routes[key]; chain[chain.length - 1]({ user, params: {}, query: {}, body: {}, headers: {} }, { setHeader() {}, status() { return this; }, json: resolve }, reject); });

const mkEl = (init = {}) => { const e = { innerHTML: '', textContent: '', value: '', hidden: false, _a: {}, _h: {}, children: [], ...init };
    e.setAttribute = (k, v) => { e._a[k] = v; }; e.getAttribute = (k) => e._a[k]; e.removeAttribute = (k) => { delete e._a[k]; }; e.classList = { toggle() {}, add() {}, remove() {} };
    e.addEventListener = (t, f) => { (e._h[t] = e._h[t] || []).push(f); }; e.querySelector = (s) => (s === 'span' ? e._span : null); e.querySelectorAll = () => []; e.insertAdjacentElement = (w, n) => { (e.after = e.after || []).push(n); }; e.remove = () => {}; e.closest = () => null; return e; };

async function run({ program, user }) {
    const joins = [mkEl({ _span: mkEl() }), mkEl({ _span: mkEl() })];
    const ids = {}; const get = (id) => ids[id] || (ids[id] = mkEl());
    ids.gaN = mkEl({ value: '5' }); ids.gaR = mkEl({ value: '50' });
    const heroEl = mkEl(); const lists = { '[data-join]': joins, '[data-art="hero"]': [heroEl] };
    const body = mkEl(); body.setAttribute('data-program', program);
    const doc = { body, getElementById: get, querySelector: () => null, createElement: () => mkEl(), querySelectorAll: (s) => lists[s] || [], addEventListener() {}, defaultView: null };
    const win = { document: doc, setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (t) => clearTimeout(t), location: { hostname: 'localhost', origin: 'http://localhost:4000', host: 'localhost:4000', protocol: 'http:' }, localStorage: { getItem: () => (user ? 'h.' + Buffer.from(JSON.stringify({ exp: 4102444800 })).toString('base64') + '.s' : null) }, sessionStorage: { getItem: () => null }, atob: (s) => Buffer.from(s, 'base64').toString('binary') };
    win.fetch = async (url) => {
        const p = url.replace('http://localhost:4000/api', '');
        try {
            if (p === '/growth/rules') { const b = await call('get /rules', null); return { ok: true, status: 200, json: async () => b }; }
            if (p === '/growth/me') { const b = await call('get /me', user); return { ok: true, status: 200, json: async () => b }; }
        } catch (e) { return { ok: false, status: e.status || 500, json: async () => ({ message: e.message }) }; }
        return { ok: false, status: 404, json: async () => ({}) };
    };
    const sandbox = { window: win, document: doc, console, Promise, Date, Number, String, Math, JSON, Object, Array, Set, Map, atob: win.atob, Buffer, setTimeout, isFinite, encodeURIComponent, globalThis: undefined };
    sandbox.fetch = win.fetch; vm.createContext(sandbox); sandbox.globalThis = sandbox;
    const load = (f) => vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', f), 'utf8'), sandbox, { filename: f });
    for (const f of ['growth-hosts.js', 'growth-economics.js', 'growth-art.js']) load(f);
    for (const k of ['NextaHosts', 'GrowthEconomics', 'GrowthArt']) if (win[k]) sandbox[k] = win[k];
    win.window = win;
    load('growth-about.js');
    await tick(150);
    return { joins, ids, win, heroEl };
}

(async () => {
    for (const program of ['circle', 'crew']) {
        const v = await run({ program, user: null });
        const name = program === 'crew' ? 'Crew' : 'Circle';
        check(`${name} page, signed out: both buttons are working links to the program with go=1`, v.joins.every((j) => /\?go=1$/.test(j._a.href || '')), JSON.stringify(v.joins.map((j) => j._a.href)));
        check(`${name}: the live parts appear once the rules arrive (glance chips, earnings picture, compare table)`, /<li>/.test(v.ids.gaGlance.innerHTML) && /could bring/.test(v.ids.gaCalcOut.innerHTML) && /Who can join/.test(v.ids.gaCompare.innerHTML) && v.ids.gaCalcSec.hidden === false && v.ids.gaCompareSec.hidden === false);
        check(`${name}: the hero picture is drawn (the right one for the program)`, /^<svg/.test(v.heroEl.innerHTML) && (program === 'crew' ? /#F59E0B/.test(v.heroEl.innerHTML) : /#12A06F/.test(v.heroEl.innerHTML)));
    }
    const crew = await run({ program: 'crew', user: null });
    check('Crew: the rank medals are drawn from the live ranks, one per rank', (crew.ids.gaLadder.innerHTML.match(/<svg/g) || []).length === 4 && /Trailhead/.test(crew.ids.gaLadder.innerHTML) && crew.ids.gaLadderSec.hidden === false);
    check('Crew: the rank buttons carry medals and the first is selected', /role="radio" aria-checked="true"/.test(crew.ids.gaCalc.innerHTML) && (crew.ids.gaCalc.innerHTML.match(/data-rank=/g) || []).length === 4);

    const ann = mk('u_ann', 'Ann'); await growth.partners.joinCircle(ann, { phone: '0772000111', agreedTerms: true, ip: '10.0.0.1' });
    let v = await run({ program: 'circle', user: ann });
    check('a Circle member on About Circle sees "Open my dashboard" and goes to the program page with go=1, so it is never bounced back', v.joins.every((j) => j._span.textContent === 'Open my dashboard' && j._a.href === '/circle?go=1'), JSON.stringify(v.joins.map((j) => [j._span.textContent, j._a.href])));
    v = await run({ program: 'crew', user: ann });
    check('the same Circle member on About Crew is offered "Upgrade", sent to the Crew page, and told Circle keeps working', v.joins.every((j) => /Upgrade to NextaStore Crew/.test(j._span.textContent) && /\/crew\?go=1$/.test(j._a.href)) && v.joins[0].after && /keeps working/.test(v.joins[0].after[0].textContent), JSON.stringify(v.joins.map((j) => [j._span.textContent, j._a.href, j.after && j.after[0] && j.after[0].textContent])));
    check('no unhandled errors', unhandled.length === 0, unhandled.map((e) => (e && e.stack) || e).join(' | ').slice(0, 400));
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
