/**
 * WIP 112: the Circle / Crew app shell (js/growth-shell.js) and the redirect pieces around it. No browser needed.
 * Run:  node scripts/growth-shell-test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const Shell = require(path.join(ROOT, 'js', 'growth-shell.js'));
const Hosts = require(path.join(ROOT, 'js', 'growth-hosts.js'));
let passed = 0, failed = 0;
const check = (n, ok, x) => { if (ok) { passed += 1; console.log('  ok   ' + n); } else { failed += 1; console.log('  FAIL ' + n + (x ? ' -> ' + x : '')); } };
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

console.log('Sections');
check('Circle has Home, Stores, Earnings, Share, More', Shell.tabs('circle').map((t) => t.id).join() === 'home,recruits,earn,share,more');
check('Crew has Home, Field, Stores, Earnings, More ("crew" is the internal key)', Shell.tabs('crew').map((t) => t.id).join() === 'home,field,recruits,earn,more' && Shell.tabs('crew').length === 5);
check('both bars have exactly five items (the bottom bar is a five-column grid)', Shell.tabs('circle').length === 5 && Shell.tabs('crew').length === 5);
check('a hash picks its section', Shell.tabFromHash('circle', '#earn') === 'earn' && Shell.tabFromHash('crew', '#field') === 'field');
check('a hash from the OTHER program, junk, or nothing is Home', Shell.tabFromHash('circle', '#field') === 'home' && Shell.tabFromHash('crew', '#share') === 'home' && Shell.tabFromHash('circle', '#gpJoinCard') === 'home' && Shell.tabFromHash('circle', '') === 'home' && Shell.tabFromHash('circle', '#<script>') === 'home');
const html = Shell.tabsHtml('circle', 'earn', { recruits: 3, earn: true });
check('the active item is marked for screen readers', /data-tab="earn"[^>]*aria-current="page"/.test(html) && (html.match(/aria-current/g) || []).length === 1);
check('a count and a dot render, and a big count is capped', html.includes('gp-count') && html.includes('gp-dot') && Shell.tabsHtml('circle', 'home', { recruits: 14 }).includes('9+'));
check('no badge when there is nothing to show', !Shell.tabsHtml('circle', 'home', { recruits: 0 }).includes('gp-count'));
check('every link stays on the page (data-local, hash only)', [...html.matchAll(/<a href="([^"]+)"/g)].every((m) => /^#[a-z]+$/.test(m[1])) && (html.match(/data-local/g) || []).length === 5);

console.log('\nThe header menu');
const hosts = Hosts.create({ mode: 'subdomain', main: 'https://nextastore.test', circle: 'https://circle.nextastore.test', crew: 'https://crew.nextastore.test' }, { host: 'circle.nextastore.test', hostname: 'circle.nextastore.test', protocol: 'https:' });
const member = { status: 'active', code: 'CIRCLE-K7M3Q' };
const m = Shell.menuModel({ program: 'circle', partner: member, user: { role: 'buyer' }, hosts });
check('a member sees their own things first: home, earnings, copy link, payout number', /href="#home"/.test(m.itemsHtml) && /href="#earn"/.test(m.itemsHtml) && /data-gp-action="copy"/.test(m.itemsHtml) && /data-gp-action="payout"/.test(m.itemsHtml));
check('the role line is the program, not "Buyer account"', m.role === 'Circle member · CIRCLE-K7M3Q');
check('way back to the main site is absolute (the program host has no /marketplace of its own)', m.itemsHtml.includes('href="https://nextastore.test/marketplace"') && m.itemsHtml.includes('href="https://nextastore.test/messages"'));
check('the info page and terms are the main site\'s', m.itemsHtml.includes('href="https://nextastore.test/about-circle"') && m.itemsHtml.includes('href="https://nextastore.test/terms"'));
check('no marketplace-only items leak in (orders, favourites, become a seller, earn with NextaStore)', !/Orders|Favorites|Following|Become a seller|Earn with/.test(m.itemsHtml));
check('a seller also gets the way to their store dashboard; a buyer does not', Shell.menuModel({ program: 'circle', partner: member, user: { role: 'seller' }, hosts }).itemsHtml.includes('https://nextastore.test/dashboard') && !m.itemsHtml.includes('/dashboard'));
const crew = Shell.menuModel({ program: 'crew', partner: { status: 'active', code: 'CREW-4HTR9' }, user: {}, hosts });
check('Crew says Crew and points at About Crew', crew.role === 'Crew member · CREW-4HTR9' && crew.itemsHtml.includes('https://nextastore.test/about-crew') && crew.itemsHtml.includes('About Crew'));
const applicant = Shell.menuModel({ program: 'crew', partner: { status: 'applied', code: 'CREW-X' }, user: {}, hosts });
check('an applicant gets no money actions, only the way back and the info page', applicant.role === 'Crew applicant' && !/data-gp-action|#earn/.test(applicant.itemsHtml) && applicant.itemsHtml.includes('marketplace'));
const early = Shell.menuModel({ program: 'circle', partner: null, user: null, hosts });
check('before the dashboard has loaded the menu is still usable', early.role === 'Circle' && early.itemsHtml.includes('marketplace') && !/data-gp-action/.test(early.itemsHtml));
const evil = Shell.menuModel({ program: 'circle', partner: { status: 'active', code: '"><img src=x onerror=alert(1)>' }, user: {}, hosts });
check('a code is escaped before it goes into the menu', !evil.role.includes('<img') && evil.role.includes('&lt;img'));
const pathMenu = Shell.menuModel({ program: 'circle', partner: member, user: {}, hosts: Hosts.create(null, { hostname: 'localhost', host: 'localhost:4000', protocol: 'http:' }) });
check('without subdomains the links stay on the same site', pathMenu.itemsHtml.includes('href="/marketplace"') && pathMenu.itemsHtml.includes('href="/about-circle"'));

console.log('\nThe pages');
for (const [file, prog] of [['circle.html', 'circle'], ['crew.html', 'crew']]) {
    const h = read(file);
    check(`${file}: header menu + bottom bar + program account slot are in place`, h.includes('id="gpTopNav"') && h.includes('id="gpTabbar"') && h.includes('data-account-nav data-account-program'));
    check(`${file}: the shell loads before main.js (which draws the menu)`, h.indexOf('growth-shell.js') > 0 && h.indexOf('growth-shell.js') < h.indexOf('/js/main.js'));
    check(`${file}: no leftover marketplace nav (Dashboard / Messages) hard-coded in the header`, !/<nav aria-label="Navigation">/.test(h));
    check(`${file}: the signed-out redirect goes to the about page through the shared helper`, h.includes(`NextaHosts.about('${prog}')`));
    check(`${file}: footer links to its About page`, h.includes(prog === 'circle' ? 'href="/about-circle"' : 'href="/about-crew"'));
}
const bridge = read('auth-bridge.html');
check('auth-bridge has the sign-out hop and only returns to our own hosts', /mode'\) === 'logout'/.test(bridge) && /allowed\.indexOf\(to\.origin\) < 0/.test(bridge));
check('auth-bridge sends sign-in back through login.html\'s ?redirect=, which it understands (the old ?next= was ignored)', bridge.includes("'/login?redirect='") && !bridge.includes('login?next='));
const main = read('js/main.js');
check('main.js: logging out on a program host goes through the bridge', main.includes('auth-bridge?mode=logout'));
check('main.js: an ended session on a program host logs in on the main site and comes back to the program', main.includes("HP.kind === 'crew' ? 'crew' : 'circle'"));
const g = read('js/growth.js');
check('growth.js: no application-review promise is read from the payout setting any more', !/payWithinWorkingDays\} working days\.<\/li><li>Log/.test(g) && !g.includes('usually takes up to'));
check('growth.js: a member opening the other program is told why they were moved', g.includes('?wrong=1') && g.includes('An account is in one program at a time'));

console.log('\nNotifications');
{
    const created = [];
    const { createContext } = (() => { try { return require(path.join(__dirname, '..', 'src', 'growth', 'context.js')); } catch (e) { return {}; } })();
    const { createHosts } = require(path.join(__dirname, '..', 'src', 'growth', 'hosts.js'));
    const make = createContext || null;
    if (make) {
        const ctx = make({ prisma: { growthPartner: { findUnique: async () => ({ program: 'crew' }) } }, hosts: createHosts({ mode: 'subdomain', rootDomain: 'nextastore.test' }), createNotification: async (n) => { created.push(n); } });
        (async () => {
            await ctx.notify('u1', 't', 'b', '/circle'); await ctx.notify('u1', 't', 'b');
            check('in subdomain mode a program notification still carries a plain path the bell will follow', created.map((n) => n.link).join() === '/circle,/crew', created.map((n) => n.link).join());
            console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
        })();
        return;
    }
    check('context.js exposes createContext (needed by this check)', false);
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
