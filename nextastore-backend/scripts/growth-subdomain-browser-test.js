/**
 * Subdomain end-to-end test. One server answers for three real host names, exactly like one Express app behind a
 * proxy would:  nextastore.test (main), circle.nextastore.test, crew.nextastore.test.  Chromium is pointed at them
 * with --host-resolver-rules, so each host is a genuinely separate origin with its OWN localStorage. That is the
 * whole reason the session hand-off exists, and it is what this test proves:
 *   - the host router (pages, redirects, manifests, service worker, frame rules, link-preview tags),
 *   - sign-in carried from the main site to circle./crew. (and signing out / switching account follows),
 *   - the invite link: who invited you, the code carried to the MAIN site's signup, the cookie fallback,
 *   - the installed Crew app opening with no signal: offline view, QR, leads queued and sent later,
 *   - notifications pointing at the right subdomain, and screenshots for a human look.
 *   PROJECT_DIR=/your/NextaStore (optional)  NODE_PATH=$(npm root -g)  node growth-subdomain-browser-test.js
 */
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawnSync } = require('child_process');

const PORT = Number(process.env.PORT || 4100);
const SHOTS = process.env.SHOTS_DIR || '/tmp/growth-shots-sub';
fs.mkdirSync(SHOTS, { recursive: true });
const ROOT = 'nextastore.localhost';   // *.localhost counts as a secure context in browsers, so service workers can be tested over plain http
const O = { main: `http://${ROOT}:${PORT}`, circle: `http://circle.${ROOT}:${PORT}`, crew: `http://crew.${ROOT}:${PORT}` };
const { createEnv } = require('./lib/test-env');
const env = createEnv({ hostsConfig: { mode: 'subdomain', main: O.main, circle: O.circle, crew: O.crew } });
const { db, growth, tokenFor, mkUser } = env;

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => { if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name} ${detail}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A page that is navigating (a sign-out or account switch does exactly that) throws "context destroyed" mid-check: treat that as "not yet".
async function until(fn, ms = 6000) { const end = Date.now() + ms; while (Date.now() < end) { try { if (await fn()) return true; } catch (e) { /* navigating: try again */ } await sleep(150); } return false; }
const decodeQr = (file) => {
    const py = `import cv2,sys\nimg=cv2.imread(sys.argv[1])\nfor d in (cv2.QRCodeDetectorAruco(), cv2.QRCodeDetector()):\n    v,_,_=d.detectAndDecode(img)\n    if v: print(v); break\n`;
    return (spawnSync('python3', ['-c', py, file], { encoding: 'utf8' }).stdout || '').trim();
};
/** A raw HTTP request to the one server, pretending to be a given host (no redirects followed). */
const raw = (host, p, { method = 'GET', headers = {} } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers: { Host: host, ...headers } }, (res) => {
        let body = ''; res.on('data', (c) => { body += c; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject); req.end();
});
const H = (kind) => new URL(O[kind]).host;

// The bundled stub signup page echoes the remembered code into #refSeen; a real signup page only has the prefilled input.
const seenCode = async (pg) => { await pg.waitForSelector('#referralCode', { timeout: 15000 }); await pg.waitForFunction(() => { const el = document.getElementById('refSeen'); return (el && el.textContent) || (document.getElementById('referralCode') || {}).value; }, null, { timeout: 15000 }).catch(() => {}); return pg.evaluate(() => { const el = document.getElementById('refSeen'); return el ? el.textContent : document.getElementById('referralCode').value; }); };

async function main() {
    await env.listen(PORT);
    let playwright;
    try { playwright = require('playwright'); } catch (e) { console.error('Playwright not found. Run with NODE_PATH=$(npm root -g).'); process.exit(2); }
    const browser = await playwright.chromium.launch({ args: ['--no-sandbox', `--host-resolver-rules=MAP ${ROOT} 127.0.0.1, MAP *.${ROOT} 127.0.0.1`] });
    const errors = [];
    const isOurs = (u) => { try { return new URL(u).hostname.endsWith(ROOT); } catch (e) { return false; } };
    async function newCtx(opts = {}) {
        const ctx = await browser.newContext({ viewport: { width: 430, height: 900 }, serviceWorkers: 'block', acceptDownloads: true, ...opts });
        await ctx.route((u) => !isOurs(u.toString()), (r) => r.abort());       // no internet in tests: fonts and icon CDNs are skipped
        return ctx;
    }
    async function newPage(ctx, label) {
        const page = await ctx.newPage();
        page.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));
        page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|net::ERR|ERR_FAILED|ERR_INTERNET/.test(m.text())) errors.push(`${label}: console: ${m.text()}`); });
        return page;
    }
    /** Sign in ON THE MAIN SITE only (that is where a person really signs in). */
    async function signInOnMain(page, user) {
        await page.goto(`${O.main}/marketplace`);
        await page.evaluate(([t, u]) => { localStorage.setItem('nextastore_token', t); localStorage.setItem('nextastore_user', u); localStorage.setItem('nextastore_remember', 'true'); }, [tokenFor(user), JSON.stringify({ id: user.id, name: user.name, role: user.role })]);
    }
    const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
    const originOf = (page) => new URL(page.url()).origin;

    // ============================================================ 1. The host router, request by request
    console.log('Host router');
    let r = await raw(H('circle'), '/');
    ok('circle host / serves the Circle page', r.status === 200 && r.body.includes('data-program="circle"') && r.body.includes('lockup-circle.svg'));
    ok('the server writes the host settings into the page', r.body.includes('window.NEXTA_HOSTS=') && r.body.includes(`"circle":"${O.circle}"`) && r.body.includes(`"crew":"${O.crew}"`));
    ok('link-preview image is an absolute URL on the circle host (crawlers do not run scripts)', r.body.includes(`content="${O.circle}/assets/growth-brand/social/circle-og-1200x630.png"`) && !r.body.includes('{{PROGRAM_URL}}'));
    ok('the page cannot be framed (it has money buttons on it)', r.headers['x-frame-options'] === 'DENY');
    r = await raw(H('crew'), '/');
    ok('crew host / serves the Crew page with the Crew preview image', r.status === 200 && r.body.includes('data-program="scout"') && r.body.includes(`${O.crew}/assets/growth-brand/social/crew-og-1200x630.png`));
    r = await raw(H('circle'), '/login?next=%2Fx');
    ok('circle host: any main-site page redirects to the main site, query kept', r.status === 302 && r.headers.location === `${O.main}/login?next=%2Fx`, r.headers.location);
    r = await raw(H('crew'), '/marketplace');
    ok('crew host: /marketplace goes to the main site', r.status === 302 && r.headers.location === `${O.main}/marketplace`);
    r = await raw(H('circle'), '/admin-growth');
    ok('the admin console is not reachable on a program host (it lives on the main site)', r.status === 302 && r.headers.location === `${O.main}/admin-growth`);
    r = await raw(H('main'), '/circle?x=1');
    ok('main host: old /circle link moves to the Circle subdomain', r.status === 302 && r.headers.location === `${O.circle}/?x=1`, r.headers.location);
    r = await raw(H('main'), '/crew');
    ok('main host: old /crew link moves to the Crew subdomain', r.status === 302 && r.headers.location === `${O.crew}/`);
    r = await raw(H('main'), '/invite?ref=CREW-4HTR9');
    ok('main host: old /invite?ref= link moves to the Circle subdomain, code kept', r.status === 302 && r.headers.location === `${O.circle}/invite?ref=CREW-4HTR9`);
    r = await raw(H('crew'), '/i/CREW-4HTR9');
    ok('crew host: the invite page always lives on the Circle host', r.status === 302 && r.headers.location === `${O.circle}/i/CREW-4HTR9`);
    r = await raw(H('circle'), '/i/CREW-4HTR9');
    ok('circle host: the short invite link /i/CODE serves the invite page', r.status === 200 && r.body.includes('id="gpInvite"'));
    r = await raw(H('circle'), '/manifest.json');
    ok('circle host: its own installable manifest (NextaStore Circle, Circle icons)', r.status === 200 && JSON.parse(r.body).name === 'NextaStore Circle' && JSON.parse(r.body).icons[0].src.includes('/favicon/circle/'));
    r = await raw(H('crew'), '/manifest.json');
    ok('crew host: its own manifest (NextaStore Crew, Crew icons)', JSON.parse(r.body).name === 'NextaStore Crew' && JSON.parse(r.body).icons[0].src.includes('/favicon/crew/') && JSON.parse(r.body).icons[2].purpose === 'maskable');
    const crewManifest = JSON.parse((await raw(H('crew'), '/manifest.json')).body);
    const iconResponses = await Promise.all(crewManifest.icons.map((i) => raw(H('crew'), i.src)));
    ok('the Crew manifest icons are real PNG files served on the Crew host', iconResponses.every((x) => x.status === 200 && /image\/png/.test(x.headers['content-type'] || '')), iconResponses.map((x) => x.status).join(','));
    ok('the Crew manifest uses the full name and the kit colours', crewManifest.name === 'NextaStore Crew' && crewManifest.short_name === 'Crew' && crewManifest.theme_color === '#0B3B2B');
    r = await raw(H('crew'), '/sw.js');
    ok('crew host: /sw.js is the growth service worker, allowed to cover /', r.status === 200 && r.body.includes('nexta-growth-') && r.headers['service-worker-allowed'] === '/');
    r = await raw(H('circle'), '/api/growth/rules');
    ok('the API answers on every host (same app), and carries the host settings', r.status === 200 && JSON.parse(r.body).data.hosts.circle === O.circle);
    r = await raw(H('main'), '/auth-bridge');
    ok('the session bridge may be framed ONLY by the two program hosts', r.status === 200 && r.headers['content-security-policy'] === `frame-ancestors ${O.circle} ${O.crew}` && r.body.includes('window.NEXTA_HOSTS='));
    r = await raw(H('circle'), '/auth-bridge');
    ok('the bridge is not served from a program host', r.status === 302 && r.headers.location === `${O.main}/auth-bridge`);
    r = await raw('evil.example', '/circle');
    ok('an unknown host is left alone (health checks, load balancers)', r.status === 404 || r.status === 200);

    // ============================================================ 2. Sign-in follows you from the main site
    console.log('Session hand-off between hosts');
    const dina = mkUser('Dina Auma');
    let ctx = await newCtx();
    let page = await newPage(ctx, 'dina');
    await page.goto(`${O.circle}/`);
    await page.waitForURL(/\/about-circle/, { timeout: 8000 });
    ok('signed out everywhere: Circle first shows the public about page on the main site', originOf(page) === O.main && new URL(page.url()).pathname === '/about-circle', page.url());
    await page.goto(`${O.circle}/?go=1`);
    await page.waitForURL(/\/login/, { timeout: 8000 });
    ok('the Join button (?go=1) then sends you to sign in, and remembers where you were going', originOf(page) === O.main && new URL(page.url()).searchParams.get('next') === `${O.circle}/?go=1`, page.url());
    await signInOnMain(page, dina);
    await page.goto(`${O.circle}/`);
    await page.waitForSelector('#gpJoin', { timeout: 10000 });
    ok('signed in on the main site: Circle opens already signed in (no second login)', originOf(page) === O.circle && (await page.textContent('#gpRoot')).includes('Bring a store into your circle'));
    ok('the token is not left in the address bar', !page.url().includes('nxs') && !page.url().includes('#'));
    ok('Circle holds its own copy of the session, for this host only', await page.evaluate(() => !!localStorage.getItem('nextastore_token') && JSON.parse(localStorage.getItem('nextastore_user')).name === 'Dina Auma'));
    const links = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.gp-top nav a, .gp-foot a')].map((a) => [a.textContent.trim(), a.href])));
    ok('header and footer links to main-site pages point at the main site, the program link stays here', links.Marketplace === `${O.main}/marketplace` && links.Messages === `${O.main}/messages` && links.Terms === `${O.main}/terms` && links.Dashboard === `${O.circle}/`, JSON.stringify(links));
    ok('the logo goes to the program home, not the marketplace', (await page.getAttribute('.gp-brand', 'href')) === '/');
    ok('the Circle lockup (with descriptor) is the header logo', (await page.getAttribute('.gp-brand img', 'src')).endsWith('/lockup-circle.svg') && (await page.evaluate(() => document.querySelector('.gp-brand img').naturalWidth)) >= 120);
    ok('Circle favicon + theme colour are set', await page.evaluate(() => document.querySelector('link[rel=icon][type="image/svg+xml"]').href.includes('/favicon/circle/') && document.querySelector('meta[name=theme-color]').content === '#0B3B2B'));
    const sizes = async () => page.evaluate(() => ({ head: document.querySelector('.gp-brand img').getBoundingClientRect().width, foot: document.querySelector('.gp-foot img').getBoundingClientRect().width }));
    let sz = await sizes();
    ok('brand minimums on a phone: header lockup at least 160px wide, footer mark at least 48px', sz.head >= 160 && sz.foot >= 48, JSON.stringify(sz));
    await page.setViewportSize({ width: 1280, height: 900 });
    sz = await sizes();
    ok('brand minimums on a desktop: header lockup at least 160px wide, footer mark at least 48px', sz.head >= 160 && sz.foot >= 48, JSON.stringify(sz));
    await page.fill('#gpPhone', '0772 123 456'); await page.check('#gpTerms'); await page.click('#gpJoin button[type=submit]');
    await page.waitForSelector('#gpCode', { timeout: 8000 });
    const dinaCode = (await page.textContent('#gpCode')).trim();
    ok('Dina joins Circle on the subdomain', /^CIRCLE-[A-Z2-9]{5}$/.test(dinaCode));
    ok('her invite link is the short link on the Circle host', (await page.textContent('#gpLinkText')) === `${O.circle}/i/${dinaCode}`, await page.textContent('#gpLinkText'));
    ok('welcome notification links to the Circle subdomain', db.notification.some((n) => /Welcome to NextaStore Circle/.test(n.title) && n.link === `${O.circle}/`), JSON.stringify(db.notification.map((n) => n.link)));
    await page.waitForSelector('#gpCardPreview svg');
    ok('the invite card shows the Circle lockup and her code', (await page.innerHTML('#gpCardPreview')).includes('<image') && (await page.innerHTML('#gpCardPreview')).includes(dinaCode));
    await shot(page, '10-circle-dashboard-desktop');
    await page.waitForSelector('#gpCardPreview svg');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#gpCardSave')]);
    const pngPath = path.join(SHOTS, 'card.png'); await dl.saveAs(pngPath);
    ok('the saved card scans to her SHORT subdomain link', decodeQr(pngPath) === `${O.circle}/i/${dinaCode}`, decodeQr(pngPath));

    // sign out on the main site: Circle follows
    const mainPage = await newPage(ctx, 'dina-main');
    await mainPage.goto(`${O.main}/marketplace`);
    await mainPage.evaluate(() => ['nextastore_token', 'nextastore_user', 'nextastore_remember'].forEach((k) => localStorage.removeItem(k)));
    await page.reload();
    await page.waitForURL(/\/about-circle/, { timeout: 12000 });   // signed out everywhere: back to the public about page, not a login wall
    ok('after signing out on the main site, opening Circle signs you out there too (and shows the about page)', originOf(page) === O.main && await (async () => { await page.goto(`${O.circle}/_probe`).catch(() => {}); return true; })());
    await ctx.close();

    // switching accounts on the main site: Circle follows
    const eve = mkUser('Eve Namuli'); const fay = mkUser('Fay Okello');
    ctx = await newCtx(); page = await newPage(ctx, 'switch');
    await signInOnMain(page, eve);
    await page.goto(`${O.circle}/`); await page.waitForSelector('#gpJoin', { timeout: 10000 });
    ok('Eve is signed in on Circle', await page.evaluate(() => JSON.parse(localStorage.getItem('nextastore_user')).name === 'Eve Namuli'));
    const mp = await newPage(ctx, 'switch-main'); await signInOnMain(mp, fay); await mp.close();
    await page.reload();
    ok('Fay signs in on the main site: Circle switches to Fay (nobody is left signed in as the wrong person)', await until(async () => page.evaluate(() => { try { return JSON.parse(localStorage.getItem('nextastore_user')).name === 'Fay Okello'; } catch (e) { return false; } }), 12000));
    await ctx.close();

    // ============================================================ 3. The invite link, as a stranger sees it
    console.log('Invite link on the Circle host');
    ctx = await newCtx(); page = await newPage(ctx, 'stranger');
    await page.goto(`${O.circle}/i/${dinaCode}`);
    await page.waitForSelector('#gpGo', { timeout: 8000 });
    const inviteText = await page.textContent('#gpInvite');
    ok('the short link shows who invited you, first name only', inviteText.includes('Dina invited you') && !inviteText.includes('Auma'));
    ok('no sign-in needed to see it', originOf(page) === O.circle && !page.url().includes('login'));
    ok('"Open my free shop" goes to the MAIN site signup with the code', (await page.getAttribute('#gpGo', 'href')) === `${O.main}/signup?ref=${dinaCode}`, await page.getAttribute('#gpGo', 'href'));
    ok('invite page uses the NextaStore logo and the Circle colourway', (await page.getAttribute('.gp-brand img', 'src')).includes('/assets/brand/') && (await page.getAttribute('body', 'data-program')) === 'circle');
    await page.setViewportSize({ width: 1280, height: 900 }); await shot(page, '11-invite-desktop'); await page.setViewportSize({ width: 430, height: 900 });
    await page.click('#gpGo');
    await page.waitForURL(/\/signup/, { timeout: 8000 });
    ok('the signup page on the main site receives the code', originOf(page) === O.main && (await seenCode(page)) === dinaCode && (await page.inputValue('#referralCode')) === dinaCode);
    // typed straight into the main site later, with no ?ref=: the parent-domain cookie still carries it
    const page2 = await newPage(ctx, 'stranger-2');
    await page2.goto(`${O.main}/signup`);
    ok('opening the main-site signup later, by hand, still knows the code (cookie on the parent domain)', (await seenCode(page2)) === dinaCode);
    await ctx.close();
    // a code printed before the rename (SCOUT-...) must keep working
    const old1 = mkUser('Hema Tendo');
    db.growthPartner.push({ id: 'gp_old', userId: old1.id, program: 'scout', status: 'active', code: 'SCOUT-HEMTA', displayName: 'Hema Tendo', phone: '256753222000', territories: ['kampala'], rankKey: 'trailhead', qualityScore: 70, joinedAt: new Date(Date.now() - 20 * 86400000), approvedAt: new Date(Date.now() - 19 * 86400000), usualIpPrefixes: [], payoutNumber: null, kycFileUrl: 'private/x', createdAt: new Date() });
    ctx = await newCtx(); page = await newPage(ctx, 'legacy');
    await page.goto(`${O.circle}/i/SCOUT-HEMTA`);
    await page.waitForSelector('#gpGo');
    ok('a code printed before the rename (SCOUT-...) still opens the invite and names who invited', (await page.textContent('#gpInvite')).includes('Hema invited you') && (await page.getAttribute('#gpGo', 'href')) === `${O.main}/signup?ref=SCOUT-HEMTA`);
    ok('the invite page says "NextaStore Crew member" for a field-team code', (await page.textContent('#gpInvite')).includes('NextaStore Crew member'));
    await page.goto(`${O.circle}/invite?ref=SCOUT-HEMTA`);
    await page.waitForSelector('#gpGo');
    ok('the old long link form works too', (await page.textContent('#gpInvite')).includes('Hema invited you'));
    await ctx.close();
    ctx = await newCtx(); page = await newPage(ctx, 'stranger-3');
    await page.goto(`${O.circle}/i/CIRCLE-ZZZZZ`);
    await page.waitForSelector('#gpGo');
    ok('an unknown code gives a friendly plain invite with a gentle note', (await page.textContent('#gpInvite')).includes('You are invited') && (await page.textContent('#gpInvite')).includes('could not match') && (await page.getAttribute('#gpGo', 'href')) === `${O.main}/signup`);
    await ctx.close();

    // ============================================================ 4. Crew: the installed app and no signal
    console.log('Crew app: install, offline, QR, queue');
    const kofi = mkUser('Kofi Mensah');
    db.growthPartner.push({ id: 'gp_kofi', userId: kofi.id, program: 'scout', status: 'active', code: 'CREW-KOFI2', displayName: 'Kofi Mensah', phone: '256753111000', territories: ['kampala'], rankKey: 'trailhead', qualityScore: 70, joinedAt: new Date(Date.now() - 20 * 86400000), approvedAt: new Date(Date.now() - 19 * 86400000), usualIpPrefixes: [], payoutNumber: null, kycFileUrl: 'private/x', createdAt: new Date() });
    ctx = await newCtx({ serviceWorkers: 'allow' });
    page = await newPage(ctx, 'kofi');
    await signInOnMain(page, kofi);
    await page.goto(`${O.crew}/`);
    await page.waitForSelector('#gpLead', { timeout: 12000 });
    ok('Crew opens signed in, in the Crew colourway with the Crew lockup', originOf(page) === O.crew && (await page.getAttribute('.gp-brand img', 'src')).endsWith('/lockup-crew.svg') && (await page.getAttribute('body', 'data-program')) === 'scout');
    ok('Crew favicon + manifest are the Crew ones', await page.evaluate(() => document.querySelector('link[rel=icon][type="image/svg+xml"]').href.includes('/favicon/crew/')));
    ok('the Crew invite link also lives on the Circle host', (await page.textContent('#gpLinkText')) === `${O.circle}/i/CREW-KOFI2`);
    await page.setViewportSize({ width: 1280, height: 900 }); await shot(page, '12-crew-dashboard-desktop'); await page.setViewportSize({ width: 430, height: 900 });
    ok('the Crew hero is gold-on-forest (primary button is gold with ink text)', await page.evaluate(() => { const b = getComputedStyle(document.querySelector('#gpLead button[type=submit]')); return b.backgroundColor === 'rgb(255, 176, 56)' && b.color === 'rgb(11, 59, 43)'; }));
    const swReady = await page.evaluate(async () => { try { const reg = await navigator.serviceWorker.ready; return !!reg.active; } catch (e) { return false; } });
    ok('the Crew app registers its service worker (installable, works offline)', swReady);
    await page.reload(); await page.waitForSelector('#gpLead');           // now controlled by the worker: this copy of the page is saved
    await sleep(500);
    await ctx.setOffline(true);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#gpQr', { timeout: 12000 });
    ok('opened with NO signal, the saved app still opens (offline view, not an error page)', (await page.textContent('#gpRoot')).includes('No signal, no problem'));
    ok('offline view shows her code and an "offline" banner', (await page.textContent('#gpCode')).trim() === 'CREW-KOFI2' && (await page.locator('.gp-offline').count()) === 1);
    await page.click('#gpQr'); await page.waitForSelector('#gpQrBox canvas');
    const qrPng = path.join(SHOTS, 'offline-qr.png'); await page.locator('#gpQrBox canvas').screenshot({ path: qrPng });
    ok('the QR still works offline and scans to her link', decodeQr(qrPng) === `${O.circle}/i/CREW-KOFI2`, decodeQr(qrPng));
    await page.click('#gpQx');
    await page.fill('#gpLb', 'Quiet Kiosk'); await page.fill('#gpLp', '0779 000 123');
    await page.click('#gpLead button[type=submit]');
    await page.waitForSelector('#gpQueue', { timeout: 6000 });
    ok('a lead logged offline is saved on the phone', (await page.textContent('#gpQueue')).includes('1 lead saved on your phone') && !db.growthReferral.some((x) => x.leadBusiness === 'Quiet Kiosk'));
    await shot(page, '13-crew-offline');
    await ctx.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    ok('signal back: the real dashboard loads and the queued lead is sent', await until(() => db.growthReferral.some((x) => x.leadBusiness === 'Quiet Kiosk' && x.stage === 'lead'), 10000));
    await page.waitForSelector('#gpMoney', { timeout: 8000 });
    ok('the offline view is replaced by the dashboard', (await page.locator('#gpMoney').count()) === 1 && (await page.locator('.gp-offline').count()) === 0);
    ok('Crew notifications that name no page still go to the Crew host', await (async () => { await growth.ctx.notify(kofi.id, 'probe', 'x'); return db.notification.some((n) => n.title === 'probe' && n.link === `${O.crew}/`); })());
    await ctx.close();

    // ============================================================ 5. Admin stays on the main site
    console.log('Admin console on the main site');
    const adm = mkUser('Admin One', { role: 'admin' });
    ctx = await newCtx({ viewport: { width: 1280, height: 900 } }); page = await newPage(ctx, 'admin');
    await signInOnMain(page, adm);
    await page.goto(`${O.main}/admin-growth#overview`);
    await page.waitForSelector('#agRoot .gp-card', { timeout: 8000 });
    ok('admin console works on the main site with the Circle lockup', originOf(page) === O.main && (await page.getAttribute('.gp-brand img', 'src')).endsWith('/lockup-circle.svg'));
    await shot(page, '14-admin-overview-desktop');
    await ctx.close();

    ok('no JavaScript errors on any page', errors.length === 0, `\n      ${errors.join('\n      ')}`);
    await browser.close(); env.server.close();
    console.log(`\n${pass} passed, ${fail} failed   (screenshots: ${SHOTS})`);
    process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
