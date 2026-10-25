/**
 * Subdomain logic, without a browser: host settings, the open-redirect guard, the host router (with fake requests),
 * CORS, and that the server and browser halves of the host logic agree. Run: node scripts/growth-hosts-test.js
 */
const path = require('path');
const { createHosts } = require('../src/growth/hosts');
const { createHostRouter } = require('../src/growth/subdomains');
const C = require('../src/growth/commission');
const R = require('../src/growth/rules');
const NextaHosts = require('../../js/growth-hosts.js');   // the browser module, loaded in Node (it is a UMD file)

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => { if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name} ${detail}`); } };
const throws = (fn) => { try { fn(); return false; } catch (e) { return e.message; } };

console.log('Host settings');
const sub = createHosts({ mode: 'subdomain', rootDomain: 'NextaStore.com' });
ok('a root domain gives main, circle. and crew. (lower-cased, https)', sub.origins.main === 'https://nextastore.com' && sub.origins.circle === 'https://circle.nextastore.com' && sub.origins.crew === 'https://crew.nextastore.com');
ok('MAIN_ORIGIN can override just the main site (www.)', createHosts({ mode: 'subdomain', rootDomain: 'nextastore.com', main: 'https://www.nextastore.com/' }).origins.main === 'https://www.nextastore.com');
ok('subdomain mode with nothing configured is refused with a clear message', /GROWTH_ROOT_DOMAIN/.test(throws(() => createHosts({ mode: 'subdomain' }))));
ok('an origin with a path is refused', /no path/.test(throws(() => createHosts({ mode: 'subdomain', main: 'https://a.com/x', circle: 'https://c.a.com', crew: 'https://s.a.com' }))));
ok('the same host twice is refused', /three different/.test(throws(() => createHosts({ mode: 'subdomain', main: 'https://a.com', circle: 'https://a.com', crew: 'https://s.a.com' }))));
const path_ = createHosts({});
ok('the default is path mode, which behaves exactly like v1 to v3', path_.mode === 'path' && path_.programUrl('scout') === '/crew' && path_.programUrl('circle') === '/circle' && path_.inviteUrl('circle-abcde') === '/invite?ref=CIRCLE-ABCDE' && path_.mainUrl('/login') === '/login');
ok('subdomain links are absolute', sub.programUrl('scout') === 'https://crew.nextastore.com/' && sub.inviteUrl('crew-4htr9') === 'https://circle.nextastore.com/i/CREW-4HTR9' && sub.mainUrl('/login') === 'https://nextastore.com/login');
ok('the host a request came in on is recognised (with its port)', createHosts({ mode: 'subdomain', main: 'http://x.test:4000', circle: 'http://c.x.test:4000', crew: 'http://s.x.test:4000' }).kindOfHost('C.X.test:4000') === 'circle' && sub.kindOfHost('evil.com') === null);

console.log('The hand-off never sends anyone to a stranger');
const evil = ['https://evil.com/', 'https://circle.nextastore.com.evil.com/', 'https://evilcircle.nextastore.com/', '//evil.com', 'javascript:alert(1)', 'https://user:pw@circle.nextastore.com/', 'http://circle.nextastore.com/', 'https://circle.nextastore.com:8443/'];
ok('look-alike, userinfo, wrong-scheme and wrong-port addresses are all refused', evil.every((u) => sub.safeReturn(u) === null), evil.filter((u) => sub.safeReturn(u) !== null).join(' '));
ok('our own hosts are accepted, path and query kept', sub.safeReturn('https://crew.nextastore.com/a?b=1') === 'https://crew.nextastore.com/a?b=1' && sub.safeReturn('https://nextastore.com/') !== null);
ok('in path mode no hand-off address is ever accepted', path_.safeReturn('https://circle.nextastore.com/') === null);

console.log('Server and browser agree');
const loc = (url) => { const u = new URL(url); return { hostname: u.hostname, host: u.host, protocol: u.protocol, port: u.port, origin: u.origin }; };
const cfg = sub.publicConfig();
const b = NextaHosts.create(cfg, loc('https://crew.nextastore.com/'));
ok('the browser derives the same settings from the address alone (no configuration)', JSON.stringify(NextaHosts.create(undefined, loc('https://crew.nextastore.com/')).publicConfig()) === JSON.stringify(cfg));
ok('invite links match, character for character', b.invite('crew-4htr9') === sub.inviteUrl('crew-4htr9'));
ok('program and main links match', b.program('scout', '/x') === sub.programUrl('scout', '/x') && b.program('circle') === sub.programUrl('circle') && b.main('/login') === sub.mainUrl('/login'));
ok('the browser knows which host it is on', b.kind === 'crew' && b.isProgramHost && NextaHosts.create(cfg, loc('https://nextastore.com/')).kind === 'main');
ok('path mode agrees too (localhost is never mistaken for subdomain mode)', NextaHosts.create(undefined, loc('http://localhost:4000/')).mode === 'path' && NextaHosts.create(undefined, loc('http://localhost:4000/')).program('scout') === path_.programUrl('scout'));
ok('links on a program host: main-site pages are rewritten, program assets and home stay', b.resolve('/marketplace?x=1') === 'https://nextastore.com/marketplace?x=1' && b.resolve('/css/growth.css') === '/css/growth.css' && b.resolve('/') === '/' && b.resolve('/circle') === 'https://circle.nextastore.com/' && b.resolve('/i/ABC') === 'https://circle.nextastore.com/i/ABC' && b.resolve('//evil.com') === '//evil.com' && b.resolve('https://x.com') === 'https://x.com');


console.log('Brand files (kit v5): nothing points at a file that is not there');
const fs = require('fs');
const FE = path.join(__dirname, '..', '..');
// The project root now also holds the whole NextaStore site, so skip folders that are not pages or scripts.
const SKIP_DIRS = new Set(['assets', 'node_modules', '.git', 'ai-assistant', 'changelog-archive', 'wip-zips', 'errors']);
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (SKIP_DIRS.has(e.name) ? [] : walk(path.join(d, e.name))) : [path.join(d, e.name)]));
const sources = walk(FE).filter((f) => /\.(html|js|css)$/.test(f) && !/[\\/]scripts[\\/]/.test(f));
// The growth program's own files (pages, scripts, css, and the backend folder): what the old-name checks look at.
const growthSources = sources.filter((f) => /[\\/](circle|crew|invite|admin-growth|auth-bridge)\.html$|[\\/]css[\\/]growth\.css$|[\\/]js[\\/](growth[^\\/]*|invite|admin-growth)\.js$|[\\/]src[\\/]growth[\\/]/.test(f));
const refs = new Set();
for (const f of sources) for (const m of fs.readFileSync(f, 'utf8').matchAll(/\/assets\/growth-brand\/[A-Za-z0-9_\-\/.]+\.(?:svg|png|ico|webp)/g)) refs.add(m[0]);
const missing = [...refs].filter((r) => !fs.existsSync(path.join(FE, r)));
ok(`every brand file the pages, scripts and css name exists (${refs.size} references)`, missing.length === 0, missing.join(' '));
const dynamic = ['svg/mark-circle.svg', 'svg/mark-crew.svg', 'svg/favicon-circle.svg', 'svg/favicon-crew.svg', 'svg/lockup-circle.svg', 'svg/lockup-crew.svg', 'svg/lockup-circle-white.svg', 'svg/lockup-crew-white.svg', 'social/circle-og-1200x630.png', 'social/crew-og-1200x630.png', ...['circle', 'crew'].flatMap((p) => ['favicon.svg', 'favicon.ico', 'favicon-16.png', 'favicon-32.png', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png'].map((f) => `favicon/${p}/${f}`))];
ok('every file the code builds a name for at run time exists (marks, lockups, favicons, icons, previews)', dynamic.every((f) => fs.existsSync(path.join(FE, 'assets', 'growth-brand', f))), dynamic.filter((f) => !fs.existsSync(path.join(FE, 'assets', 'growth-brand', f))).join(' '));
const stale = growthSources.filter((f) => /growth-brand\/[^"' )`]*scouts|\/favicon\/scouts/.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(FE, f));
ok('no page or script still points at the old Scouts brand files', stale.length === 0, stale.join(' '));
const textLeft = growthSources.filter((f) => /Nexta Scouts|Nexta Circle|NextaScouts/.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(FE, f));
ok('no page or script still shows the old names "Nexta Scouts" / "Nexta Circle"', textLeft.length === 0, textLeft.join(' '));
const pages = ['circle.html', 'crew.html'].map((f) => fs.readFileSync(path.join(FE, f), 'utf8'));
ok('each program page names itself in full (NextaStore Circle / NextaStore Crew) and carries its descriptor', pages[0].includes('<title>NextaStore Circle · Affiliate Program</title>') && pages[1].includes('<title>NextaStore Crew · Field Team</title>') && pages[1].includes('alt="NextaStore Crew, field team"') && pages[0].includes('alt="NextaStore Circle, affiliate program"'));
ok('full marks in the footers are at least 48px (kit minimum)', pages.every((p) => /<footer[\s\S]*?width="(\d+)" height="(\d+)"/.test(p) && Number(p.match(/<footer[\s\S]*?width="(\d+)"/)[1]) >= 48));

console.log('Host router (fake requests)');
const router = createHostRouter({ hosts: sub, pagesDir: path.join(__dirname, '..', '..'), cache: false });
function call(host, url, { method = 'GET', headers = {} } = {}) {
    return new Promise((resolve) => {
        const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, removeHeader(k) { delete this.headers[k.toLowerCase()]; }, end(body) { resolve({ status: this.statusCode, headers: this.headers, body: String(body || ''), next: false }); } };
        router({ url, method, headers: { host, ...headers }, socket: { encrypted: true } }, res, () => resolve({ next: true, headers: res.headers }));
    });
}
(async () => {
    let r = await call('nextastore.com', '/api/growth/rules', { headers: { origin: 'https://nextastore.com' } });
    ok('API: a same-origin request gets no CORS headers (nothing to add)', r.next === true && !r.headers['access-control-allow-origin']);
    r = await call('nextastore.com', '/api/growth/me', { headers: { origin: 'https://crew.nextastore.com' } });
    ok('API: a request from a growth origin gets exactly that origin back, never *, and Vary: Origin', r.next === true && r.headers['access-control-allow-origin'] === 'https://crew.nextastore.com' && r.headers.vary === 'Origin');
    r = await call('nextastore.com', '/api/growth/me', { headers: { origin: 'https://evil.com' } });
    ok('API: a request from any other origin gets no permission headers', r.next === true && !r.headers['access-control-allow-origin']);
    const pre = await call('nextastore.com', '/api/growth/me', { method: 'OPTIONS', headers: { origin: 'https://circle.nextastore.com' } });
    ok('CORS preflight from a growth origin is answered with 204 and that origin', pre.status === 204 && pre.headers['access-control-allow-origin'] === 'https://circle.nextastore.com' && pre.headers.vary === 'Origin' && /Authorization/.test(pre.headers['access-control-allow-headers']));
    const bad = await call('nextastore.com', '/api/growth/me', { method: 'OPTIONS', headers: { origin: 'https://evil.com' } });
    ok('CORS preflight from any other origin gets no permission', bad.next === true && !bad.headers['access-control-allow-origin']);
    r = await call('circle.nextastore.com', '/api/user/me', { method: 'POST' });
    ok('non-GET requests on a program host are not touched (they belong to the API)', r.next === true);
    r = await call('circle.nextastore.com', '/css/growth.css');
    ok('static assets pass through on a program host', r.next === true);
    r = await call('circle.nextastore.com', '/account/settings.html');
    ok('an html page that is not ours goes to the main site', r.status === 302 && r.headers.location === 'https://nextastore.com/account/settings.html');
    r = await call('circle.nextastore.com', '/i/not%20a%20code!');
    ok('a malformed invite path is not served as an invite', r.status === 302 && r.headers.location.startsWith('https://nextastore.com/'));
    r = await call('nextastore.com', '//circle');
    ok('doubled slashes do not dodge the redirect, and never become a host', r.status === 302 && r.headers.location.startsWith('https://circle.nextastore.com/'), r.headers && r.headers.location);
    r = await call('circle.nextastore.com', '//evil.com/x');
    ok('a request line like //evil.com/x stays a path: it is sent to OUR main site, not to evil.com', r.status === 302 && r.headers.location === 'https://nextastore.com/evil.com/x', r.headers && r.headers.location);
    r = await call('nextastore.com', '/scouts?x=1');
    ok('the old /scouts address still works: it moves to the Crew subdomain', r.status === 302 && r.headers.location === 'https://crew.nextastore.com/?x=1', r.headers && r.headers.location);
    r = await call('crew.nextastore.com', '/scouts');
    ok('and so does the old name typed on the Crew host', r.status === 302 && r.headers.location === 'https://crew.nextastore.com/');
    r = await call('circle.nextastore.com', '/crew');
    ok('/crew on the Circle host goes to the Crew host', r.status === 302 && r.headers.location === 'https://crew.nextastore.com/');
    ok('the Crew host settings are legacy-tolerant: an old SCOUTS_ORIGIN still works', createHosts({ mode: 'subdomain', main: 'https://a.com', circle: 'https://c.a.com', scouts: 'https://s.a.com' }).origins.crew === 'https://s.a.com' && createHosts({ mode: 'subdomain', rootDomain: 'a.com' }).origins.crew === 'https://crew.a.com');
    r = await call('circle.nextastore.com', '/');
    ok('the Circle page carries the Circle preview image and no unreplaced markers', r.body.includes('https://circle.nextastore.com/assets/growth-brand/social/circle-og-1200x630.png') && !/\{\{|<!--NEXTA_HOSTS-->/.test(r.body));
    const pathRouter = createHostRouter({ hosts: path_, pagesDir: path.join(__dirname, '..', '..'), cache: false });
    const pr = await new Promise((resolve) => { const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(body) { resolve({ status: this.statusCode, body: String(body) }); } }; pathRouter({ url: '/invite?ref=x', method: 'GET', headers: { host: 'localhost:4000' }, socket: {} }, res, () => resolve({ next: true })); });
    const pr2 = await new Promise((resolve) => { const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end() { resolve({ status: this.statusCode, headers: this.headers }); } }; pathRouter({ url: '/scouts', method: 'GET', headers: { host: 'localhost:4000' }, socket: {} }, res, () => resolve({ next: true })); });
    ok('path mode: the old /scouts address redirects (permanently) to /crew', pr2.status === 301 && pr2.headers.location === '/crew');
    ok('path mode serves /invite itself, with an absolute preview image on the same host', pr.status === 200 && pr.body.includes('content="http://localhost:4000/assets/growth-brand/social/circle-og-1200x630.png"'));

    console.log('Bug fixes that came with this round');
    const when = C.formatEat(new Date(Date.UTC(2026, 9, 16, 12, 40)));
    ok('the payout-number pause says a date a person can read, in East Africa Time', when === 'Fri 16 Oct, 3:40 pm', when);
    ok('midnight and noon read correctly', C.formatEat(new Date(Date.UTC(2026, 0, 1, 21, 5))).endsWith('12:05 am') && C.formatEat(new Date(Date.UTC(2026, 0, 1, 9, 0))).endsWith('12:00 pm'));
    const fail_ = C.checkWithdrawal({ partner: { status: 'active', payoutNumber: '0772123456', payoutNumberChangedAt: new Date() }, amount: 20000, balances: { available: 50000 }, now: new Date(), openWithdrawal: null, trust: R.TRUST_LEVELS.new, lastPaid: null, everPaid: false, paidLast30d: 0, firstCleared: null });
    ok('checkWithdrawal no longer prints a raw timestamp', !fail_.ok === true ? !/\d{4}-\d{2}-\d{2}T/.test(fail_.message || '') : true);

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})();
