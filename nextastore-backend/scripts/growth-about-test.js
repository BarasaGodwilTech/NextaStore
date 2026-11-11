/**
 * WIP 112: the public About Circle / About Crew pages.
 * No browser, no database, no Express needed. It builds the REAL /api/growth/rules payload from routes.js (with a stand-in router),
 * then checks the pages against it:
 *   - every data-f="..." placeholder on either page is filled by the payload (so no page is left showing "a percentage" when the API is up)
 *   - no number is typed into the visible text of either page (every figure is a placeholder)
 *   - the Join / Apply button logic for every kind of visitor
 *   - the host router serves both pages with the host settings and absolute preview addresses filled in
 * Run:  node scripts/growth-about-test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..', '..');
const G = path.join(__dirname, '..', 'src', 'growth');
let passed = 0, failed = 0;
const check = (name, ok, extra) => { if (ok) { passed += 1; console.log('  ok   ' + name); } else { failed += 1; console.log('  FAIL ' + name + (extra ? '  -> ' + extra : '')); } };
const section = (t) => console.log('\n' + t);

// ---- the real payload, through the real route table -------------------------------------------------------------------------------
function fakeExpress() {
    const routes = {};
    const Router = () => {
        const r = {};
        ['get', 'post', 'put', 'delete'].forEach((m) => { r[m] = (p, ...h) => { routes[m + ' ' + p] = h; return r; }; });
        r.routes = routes;
        return r;
    };
    return { Router };
}
const origLoad = Module._load;
const withFakeExpress = (fn) => {
    Module._load = function (request, ...rest) { return request === 'express' ? fakeExpress() : origLoad.call(this, request, ...rest); };
    try { return fn(); } finally { Module._load = origLoad; }
};
const R = require(path.join(G, 'rules.js'));
const { buildRoutes } = require(path.join(G, 'routes.js'));
const { createHosts } = require(path.join(G, 'hosts.js'));

async function rulesPayload(settings) {
    const hosts = createHosts({});
    const api = { partners: {}, hooks: {}, leads: {}, withdrawals: {}, admin: {}, ctx: { getSettings: async () => settings, hosts, prisma: {} } };
    const built = withFakeExpress(() => buildRoutes(api, { requireAuth: (q, s, n) => n(), requireAdminPermission: () => (q, s, n) => n() }));
    const handler = built.partner.routes['get /rules'].slice(-1)[0];
    let body; const res = { setHeader() {}, json(b) { body = b; } };
    await handler({}, res, (e) => { throw e; });
    return body.data;
}

const circleHtml = fs.readFileSync(path.join(ROOT, 'about-circle.html'), 'utf8');
const crewHtml = fs.readFileSync(path.join(ROOT, 'about-crew.html'), 'utf8');
const About = require(path.join(ROOT, 'js', 'growth-about.js'));

(async () => {
    const open = await rulesPayload({ circleOpen: true, crewOpen: true });
    const facts = About.facts(open);

    section('The live rules carry everything the pages talk about');
    check('application review days come from rules.js REVIEW, not from the payout promise', open.applicationReviewWorkingDays === R.REVIEW.applicationWorkingDays);
    check('click window, renewal window, rank window, quality bar, stocked-store minimum are published',
        [open.clickWindowDays, open.renewalWithinDays, open.rankWindowDays, open.rankMinQuality, open.stockedMinProducts].every((n) => Number.isFinite(n) && n > 0));
    check('the "first store must pay first" condition is published as a flag', open.payouts.firstWithdrawalNeedsStore === (R.WITHDRAWAL.firstWithdrawalNeedsClearedConversions > 0));
    check('/rules still carries the host settings', open.hosts && open.hosts.mode === 'path');

    section('Every placeholder on both pages is filled by the live payload');
    for (const [name, html] of [['about-circle', circleHtml], ['about-crew', crewHtml]]) {
        const keys = [...new Set([...html.matchAll(/data-f="([^"]+)"/g)].map((m) => m[1]))];
        const missing = keys.filter((k) => !(k in facts));
        check(`${name}: ${keys.length} placeholders, none left on fallback wording`, missing.length === 0, 'unfilled: ' + missing.join(', '));
    }
    check('facts() never prints NaN or undefined', Object.values(facts).every((v) => !/NaN|undefined|null/.test(v)));
    check('facts() on an empty payload fills nothing (the plain wording stays)', Object.keys(About.facts({})).length === 0);
    check('facts() on a half payload fills only what exists', (() => { const f = About.facts({ passPricePerMonth: 20000, programs: { circle: {} }, payouts: {} }); return Object.keys(f).join() === 'pass'; })());
    check('money is written the way the dashboards write it', facts.pass === 'UGX 20,000' && /^UGX [\d,]+$/.test(facts['c.first']));
    check('singular and plural read correctly', About.facts({ trialDays: 1, rankWindowDays: 90 }).trial === '1 day' && About.facts({ rankWindowDays: 90 }).rankWindow === '90 days');

    section('No figure is typed into the visible text of either page');
    for (const [name, html] of [['about-circle', circleHtml], ['about-crew', crewHtml]]) {
        const body = html.slice(html.indexOf('<main'), html.indexOf('</main>'));
        // remove placeholders (their fallback words are not figures), tags and the one ordered-list counter
        const text = body.replace(/<span data-f="[^"]+"[^>]*>[^<]*<\/span>/g, ' ').replace(/<[^>]+>/g, ' ');
        const found = (text.match(/[^.\s]*\d[^.\s]*/g) || []).filter((t) => !/^(60-second|5-minute)$/.test(t));
        check(`${name}: no typed figures in the text`, found.length === 0, found.join(' '));
    }

    section('The Join / Apply button for every kind of visitor');
    const c = (o) => About.cta(Object.assign({ program: 'circle', open: true, signedIn: false, member: null }, o));
    check('signed out, open: join with go=1 to the program', c({}).state === 'join' && c({}).target === 'join' && c({}).label === 'Join NextaStore Circle');
    check('Crew wording is "Apply"', c({ program: 'crew' }).label === 'Apply to join NextaStore Crew');
    check('signed in but not a member looks the same as signed out (no fake "Open my dashboard")', c({ signedIn: true }).state === 'join' && c({ signedIn: true }).label === 'Join NextaStore Circle');
    check('rules could not load: the button is still a working join link', c({ open: undefined }).state === 'join' && !c({ open: undefined }).disabled && c({ open: undefined }).status === '');
    check('closed and not a member: disabled "Not open yet", no link', c({ open: false }).disabled && c({ open: false }).target === 'none');
    check('active Circle member sees "Open my dashboard", even while the program is closed', c({ open: false, member: { program: 'circle', status: 'active' } }).label === 'Open my dashboard');
    check('frozen member still gets their dashboard', c({ member: { program: 'circle', status: 'frozen' } }).state === 'member');
    check('Crew applicant waiting for review is told so, not offered the form again', About.cta({ program: 'crew', open: true, member: { program: 'crew', status: 'applied' } }).state === 'applied');
    check('rejected / retired member is sent to their account page, not to join', c({ member: { program: 'circle', status: 'rejected' } }).label === 'View my account' && c({ member: { program: 'circle', status: 'retired' } }).state === 'closed');
    // Changed on purpose (WIP 115): a Circle member on the Crew page is offered the upgrade, and a pending request says so.
    const up = About.cta({ program: 'crew', open: true, member: { program: 'circle', status: 'active' } });
    check('a Circle member on the Crew page is offered "Upgrade to Crew", and told Circle keeps working', up.state === 'upgrade' && up.target === 'join' && /Upgrade to NextaStore Crew/.test(up.label) && /keeps working/.test(up.note));
    check('a pending upgrade request is shown as such, not as a fresh application', About.cta({ program: 'crew', open: true, member: { program: 'circle', status: 'active', upgrade: 'pending' } }).state === 'upgrade-pending');
    check('when Crew is closed the upgrade button is disabled but Circle is reassured', (() => { const c = About.cta({ program: 'crew', open: false, member: { program: 'circle', status: 'active' } }); return c.disabled && /keeps working/.test(c.note); })());
    const other = About.cta({ program: 'circle', open: true, member: { program: 'crew', status: 'active' } });
    check('a Crew member on the Circle page is still told one program at a time', other.state === 'other' && other.target === 'other' && /one program/.test(other.note) && /Crew/.test(other.label));
    const other2 = About.cta({ program: 'circle', open: true, member: { program: 'crew', status: 'applied' } });
    check('a Crew applicant on the Circle page gets the same honest note', other2.state === 'other' && /NextaStore Crew/.test(other2.note));

    section('Tokens and the rank table');
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const tok = (exp) => `h.${b64({ exp })}.s`;
    check('a live token is accepted', About.tokenOk(tok(Math.floor(Date.now() / 1000) + 3600)));
    check('an expired token is not', !About.tokenOk(tok(Math.floor(Date.now() / 1000) - 60)));
    check('garbage and empty are not', !About.tokenOk('abc') && !About.tokenOk('') && !About.tokenOk(null) && !About.tokenOk('a.b.c'));
    const rows = About.rankRows([{ label: '<b>Top</b>', minCleared90d: 5, ratePercent: 30, firstMonth: 6000 }, { label: 'Start', minCleared90d: 0, ratePercent: 25, firstMonth: 5000 }], 90);
    check('rank rows are escaped', !rows.includes('<b>Top</b>') && rows.includes('&lt;b&gt;Top&lt;/b&gt;'));
    check('rank rows spell the window from the rules', rows.includes('5 paid stores in the last 90 days') && rows.includes('Where everyone starts') && rows.includes('30% (UGX 6,000)'));
    check('with the live ranks, the table matches rules.js', About.rankRows(open.programs.crew.ranks, open.rankWindowDays).split('<tr>').length - 1 === R.CREW_RANKS.length);

    section('The host router serves the about pages with the settings filled in');
    const { createHostRouter } = require(path.join(G, 'subdomains.js'));
    const run = (router, url, host, extra = {}) => new Promise((resolve) => {
        const res = { statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, removeHeader() {}, end(b) { resolve({ status: this.statusCode, headers: this.headers, body: b ? String(b) : '' }); } };
        const req = Object.assign({ url, method: 'GET', headers: { host, 'x-forwarded-proto': 'https' }, socket: {} }, extra);
        router(req, res, () => resolve({ status: 'next' }));
    });
    const subHosts = createHosts({ mode: 'subdomain', rootDomain: 'nextastore.test' });
    const sub = createHostRouter({ hosts: subHosts, pagesDir: ROOT, cache: false });
    const main = await run(sub, '/about-circle', 'nextastore.test');
    check('main host: /about-circle is served (200)', main.status === 200 && /text\/html/.test(main.headers['content-type']));
    check('the host settings are written into the page', /window\.NEXTA_HOSTS=\{"mode":"subdomain","main":"https:\/\/nextastore\.test","circle":"https:\/\/circle\.nextastore\.test","crew":"https:\/\/crew\.nextastore\.test"\}/.test(main.body) && !main.body.includes('<!--NEXTA_HOSTS-->'));
    check('canonical and preview image are absolute addresses on the main site', main.body.includes('rel="canonical" href="https://nextastore.test/about-circle"') && main.body.includes('content="https://nextastore.test/assets/growth-brand/social/circle-og-1200x630.png"') && !main.body.includes('{{MAIN_URL}}'));
    const crew = await run(sub, '/about-crew?utm=x', 'nextastore.test');
    check('/about-crew is served too, with its own preview image', crew.status === 200 && crew.body.includes('crew-og-1200x630.png'));
    const dotHtml = await run(sub, '/about-crew.html?x=1', 'nextastore.test');
    check('/about-crew.html goes to the one clean address and keeps the query', dotHtml.status === 301 && dotHtml.headers.location === '/about-crew?x=1');
    const onCircle = await run(sub, '/about-circle', 'circle.nextastore.test');
    check('on circle. the page is the main site\'s business: redirected there', onCircle.status === 302 && onCircle.headers.location === 'https://nextastore.test/about-circle');
    const onCrew = await run(sub, '/about-crew', 'crew.nextastore.test');
    check('on crew. too', onCrew.status === 302 && onCrew.headers.location === 'https://nextastore.test/about-crew');
    const post = await run(sub, '/about-circle', 'nextastore.test', { method: 'POST' });
    check('only GET/HEAD are answered here', post.status === 'next');
    const pathRouter = createHostRouter({ hosts: createHosts({}), pagesDir: ROOT, cache: false });
    const pathMode = await run(pathRouter, '/about-crew', 'localhost:4000', { headers: { host: 'localhost:4000' } });
    check('path mode (no subdomains) serves the page with the same origin for previews', pathMode.status === 200 && pathMode.body.includes('href="http://localhost:4000/about-crew"') && pathMode.body.includes('"mode":"path"'));
    check('an unrelated path is untouched in path mode', (await run(pathRouter, '/marketplace', 'localhost:4000', { headers: { host: 'localhost:4000' } })).status === 'next');


    section('The earnings picture, the chips and the compare table');
    globalThis.GrowthEconomics = require(path.join(ROOT, 'js', 'growth-economics.js'));
    const Art = require(path.join(ROOT, 'js', 'growth-art.js'));
    const E = globalThis.GrowthEconomics;
    const circ = About.estimate(open, 'circle', null, 5, 0.5);
    check('5 Circle stores, half renewing: first-month rewards + stay bonuses, exactly as the server pays them', circ.first === 5 * E.perStore(open, 'circle', null, { months: 1 }).upfront && circ.renewals === 3 && circ.renewal === 3 * R.COMMISSION.circle.renewalBonus && circ.total === circ.first + circ.renewal);
    const top = About.estimate(open, 'crew', 'summit', 4, 1);
    check('a Summit Crew member earns more per store than a Trailhead one', top.perStore > About.estimate(open, 'crew', 'trailhead', 4, 1).perStore);
    check('absurd slider values are clamped, never NaN', Number.isFinite(About.estimate(open, 'circle', null, 'abc', 9).total) && About.estimate(open, 'circle', null, 9999, 1).stores === 200 && About.estimate(open, 'circle', null, -4, -1).total === 0);
    check('zero renewals means no stay bonus', About.estimate(open, 'circle', null, 6, 0).renewal === 0);
    const chips = About.glance(facts, 'circle');
    check('Circle chips: reward, payout time, trial, free', chips.length === 4 && /of month one/.test(chips[0]) && /^Paid within \d+ working days$/.test(chips[1]) && chips[3] === 'Free to join');
    check('Crew chips say by application and show the rate range', About.glance(facts, 'crew').slice(-1)[0] === 'By application' && /% to \d+% of month one/.test(About.glance(facts, 'crew')[0]));
    check('with no rules there are no invented chips (only the true static one)', About.glance({}, 'circle').join() === 'Free to join');
    const cmp = About.compareRows(open);
    check('the compare table has the same labels in a fixed order and live figures', cmp.length === 7 && cmp[1][1].includes('%') && cmp[4][2].startsWith(`${R.CREW_RANKS.length} ranks`) && cmp[3][2].includes('if the store is stocked'));
    check('the compare table degrades to plain words without rules', About.compareRows({}).every((r) => r.every((c) => c && !/NaN|undefined/.test(c))));

    section('The artwork');
    const svgs = [Art.hero('circle'), Art.hero('crew'), ...[0, 1, 2, 3].map((i) => Art.medal(i)), Art.ring(40)];
    check('every picture is a self-contained SVG with no scripts, links or external images', svgs.every((x) => x.startsWith('<svg') && !/<script|href=|xlink|onload|onerror|<image/i.test(x)));
    check('gradient ids are unique across medals on one page', (() => { const ids = [0, 1, 2, 3, 0].map((i) => /id="(gm\d+)"/.exec(Art.medal(i))[1]); return new Set(ids).size === 5; })());
    check('a medal is announced by name, and unknown ranks are clamped', /aria-label="Trailhead medal"/.test(Art.medal(0)) && /aria-label="Summit medal"/.test(Art.medal(99)) && /aria-label="Trailhead medal"/.test(Art.medal('x')));
    check('the progress ring clamps to 0-100 and escapes its label', Art.ring(900).includes('100%') && Art.ring(-5).includes('0%') && !Art.ring(5, { label: '<b>x</b>' }).includes('<b>x</b>'));
    check('the info pages load the economics and art scripts before the about script', [circleHtml, crewHtml].every((h) => h.indexOf('growth-economics.js') > 0 && h.indexOf('growth-art.js') > h.indexOf('growth-economics.js') && h.indexOf('growth-about.js') > h.indexOf('growth-art.js')));
    check('both pages carry the new sections, hidden until the live rules arrive', [circleHtml, crewHtml].every((h) => /id="gaCalcSec" hidden/.test(h) && /id="gaCompareSec" hidden/.test(h)) && /id="gaLadderSec" hidden/.test(crewHtml));

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
