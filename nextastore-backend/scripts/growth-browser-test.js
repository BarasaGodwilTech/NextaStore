/**
 * Real-browser end-to-end test of the growth program. It starts a small local server that serves:
 *   - YOUR site (css, js, html) from PROJECT_DIR, so the pages run against your real main.js,
 *   - the growth pages from the project root (they win over anything with the same name),
 *   - the REAL growth backend (routes, services, rules) on an in-memory database stand-in.
 * Then headless Chromium signs in as different people and uses the pages like a person would.
 *
 *   PROJECT_DIR=/path/to/NextaStore  NODE_PATH=$(npm root -g)  node growth-browser-test.js
 *   (needs Playwright with Chromium, and python3 + opencv-python + numpy for the QR decode checks)
 *
 * Honest limit: the database is an in-memory stand-in and the rest of your API (login, stores,
 * messages) is faked just enough for the pages to load. It proves the growth pages and logic work in a
 * real browser; it does not replace one pass through the real deployed app.
 */
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { createEnv } = require('./lib/test-env');

const PORT = Number(process.env.PORT || 4000); // main.js talks to http://localhost:4000/api when served from localhost
const SHOTS = process.env.SHOTS_DIR || '/tmp/growth-shots';
fs.mkdirSync(SHOTS, { recursive: true });
const env = createEnv({ hostsConfig: { mode: 'path' } });   // path mode: the original layout (/circle, /crew, /invite). The subdomain flows are in growth-subdomain-browser-test.js
const { db, growth, server, unknownApi, tokenFor, mkUser, clock } = env;
if (env.usingStub) console.log('(PROJECT_DIR not set: using the bundled stub site. Set PROJECT_DIR to run against your real main.js.)');
const HOUR = 3600000, DAY = 86400000;
const setOffset = (ms) => env.setOffset(ms);

// ---------------------------------------------------------------- helpers
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => { if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name} ${detail}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 5000) { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(100); } return false; }
const decodeQr = (file) => {
    const py = `import cv2,sys\nimg=cv2.imread(sys.argv[1])\nfor d in (cv2.QRCodeDetectorAruco(), cv2.QRCodeDetector()):\n    v,_,_=d.detectAndDecode(img)\n    if v: print(v); break\n`;
    return (spawnSync('python3', ['-c', py, file], { encoding: 'utf8' }).stdout || '').trim();
};
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

async function main() {
    await env.listen(PORT);
    const BASE = `http://localhost:${PORT}`;
    let playwright;
    try { playwright = require('playwright'); } catch (e) { console.error('Playwright not found. Run with NODE_PATH=$(npm root -g) or npm i playwright.'); process.exit(2); }
    const browser = await playwright.chromium.launch({ args: ['--no-sandbox'] });
    const errors = [];

    async function open(user, urlPath, { viewport = { width: 430, height: 940 }, noAuth = false } = {}) {
        const ctx = await browser.newContext({ acceptDownloads: true, viewport, serviceWorkers: 'block' });
        await ctx.route((u) => !u.toString().startsWith(BASE), (r) => r.abort()); // no internet in tests: CDN fonts and icons are skipped
        if (!noAuth && user) await ctx.addInitScript(([t, u]) => { localStorage.setItem('nextastore_token', t); localStorage.setItem('nextastore_user', u); localStorage.setItem('nextastore_remember', 'true'); }, [tokenFor(user), JSON.stringify({ id: user.id, name: user.name, role: user.role })]);
        const page = await ctx.newPage();
        page.on('pageerror', (e) => errors.push(`${urlPath}: ${e.message}`));
        page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|net::ERR|ERR_FAILED/.test(m.text())) errors.push(`${urlPath}: console: ${m.text()}`); });
        await page.goto(BASE + urlPath, { waitUntil: 'domcontentloaded' });
        return { ctx, page };
    }
    // Light text on the dark green header: guards against a global heading style turning it dark-on-dark again.
    const heroReadable = (page) => page.evaluate(() => {
        const lum = (rgb) => { const [r, g, b] = rgb.match(/[\d.]+/g).slice(0, 3).map(Number).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
        const els = [...document.querySelectorAll('.gp-hero h1, .gp-hero p')];
        return els.length > 0 && els.every((el) => (1.05) / (lum('rgb(15, 90, 65)') + 0.05) > 4.5 && lum(getComputedStyle(el).color) > 0.7);
    });
    const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
    const waitToast = async (page, re, ms = 6000) => { try { await page.waitForFunction((src) => new RegExp(src, 'i').test((document.querySelector('.gp-toast') || {}).textContent || ''), re.source, { timeout: ms }); return true; } catch (e) { return false; } };
    const toastText = async (page) => { await page.waitForSelector('.gp-toast', { timeout: 4000 }).catch(() => {}); return (await page.locator('.gp-toast').last().textContent().catch(() => '')) || ''; };

    // ============================================================ 1. Circle: join in the browser
    console.log('Circle: join, estimator, share studio');
    const dina = mkUser('Dina Auma');
    let { ctx, page } = await open(dina, '/circle');
    await page.waitForSelector('#gpJoin', { timeout: 8000 });
    ok('a non-member sees the pitch and the join form', (await page.textContent('#gpRoot')).includes('Bring a store into your circle'));
    ok('the Circle pitch names itself as the affiliate program next to the name', /NextaStore Circle\s*·\s*Affiliate Program/.test((await page.textContent('.gp-hero .gp-kicker')).trim()), await page.textContent('.gp-hero .gp-kicker'));
    ok('the pitch shows server numbers, not hard-coded ones (20%, UGX 4,000)', /20%/.test(await page.textContent('#gpRoot')) && (await page.textContent('#gpRoot')).includes('UGX 4,000'));
    await page.evaluate(() => { const s = document.getElementById('gpN'); s.value = '5'; s.dispatchEvent(new Event('input', { bubbles: true })); });
    const calc = await page.textContent('#gpCalcOut');
    ok('the earnings estimator updates: 5 stores x UGX 4,000 = UGX 20,000, with renewals UGX 35,000', calc.includes('UGX 20,000') && calc.includes('UGX 35,000') && (await page.textContent('#gpNLabel')) === '5 stores', calc);
    ok('the green header text is light enough to read (contrast)', await heroReadable(page));
    await shot(page, '01-circle-join');
    await page.fill('#gpPhone', '0772 123 456');
    await page.click('#gpJoin button[type=submit]');
    await page.waitForFunction(() => document.getElementById('gpErr').textContent.length > 0, null, { timeout: 5000 });
    ok('joining without accepting the terms is refused with a clear message', /terms/i.test(await page.textContent('#gpErr')) && !db.growthPartner.length);
    await page.check('#gpTerms');
    await page.click('#gpJoin button[type=submit]');
    await page.waitForSelector('#gpCode', { timeout: 8000 });
    const dinaCode = (await page.textContent('#gpCode')).trim();
    ok('the Circle dashboard header says Affiliate Program', /NextaStore Circle\s*·\s*Affiliate Program/.test(await page.textContent('.gp-hero .gp-kicker')));
    ok('joining shows the dashboard with a CIRCLE code', /^CIRCLE-[A-Z2-9]{5}$/.test(dinaCode), dinaCode);
    ok('after ticking the terms the partner row exists', db.growthPartner.some((p) => p.code === dinaCode));
    await page.waitForSelector('#gpCardPreview svg');
    ok('the Share Studio shows the invite card with her code', (await page.innerHTML('#gpCardPreview')).includes(dinaCode));
    const layout = await page.evaluate(() => {
        const svg = document.querySelector('#gpCardPreview svg'); const vb = svg.viewBox.baseVal;
        const box = (el) => { const b = el.getBBox(); return { top: b.y, bottom: b.y + b.height, left: b.x, right: b.x + b.width }; };
        const texts = [...svg.querySelectorAll('text')].map((t) => ({ text: t.textContent, ...box(t) }));
        const qr = svg.querySelector('g'); const codeRect = [...svg.querySelectorAll('rect')].find((r) => r.getAttribute('rx') === '24');
        const footer = texts[texts.length - 1], code = texts.find((t) => /^(CIRCLE|CREW)-/.test(t.text)), label = texts.find((t) => /Scan|Use my code/.test(t.text));
        return { vbH: vb.height, vbW: vb.width, qr: qr && box(qr), codeRect: box(codeRect), footer, code, label, all: texts };
    });
    const clear = (a, b) => a.bottom <= b.top;
    ok('invite card layout: QR, label, code box and web address are stacked with no overlap', layout.qr && clear(layout.qr, layout.label) && clear(layout.label, layout.codeRect) && clear(layout.codeRect, layout.footer), JSON.stringify({ qr: layout.qr, label: layout.label, codeRect: layout.codeRect, footer: layout.footer }));
    ok('invite card layout: everything stays inside the picture', layout.all.every((t) => t.top >= 0 && t.bottom <= layout.vbH && t.left >= 0 && t.right <= layout.vbW) && layout.codeRect.bottom <= layout.vbH, JSON.stringify(layout.all.filter((t) => t.right > layout.vbW || t.bottom > layout.vbH)));
    ok('invite card layout: the code text sits inside its box', layout.code.top >= layout.codeRect.top && layout.code.bottom <= layout.codeRect.bottom && layout.code.left >= layout.codeRect.left && layout.code.right <= layout.codeRect.right);
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#gpCardSave')]);
    const pngPath = path.join(SHOTS, 'invite-card.png'); await download.saveAs(pngPath);
    const png = fs.readFileSync(pngPath);
    ok('"Save as picture" downloads a real PNG', png.slice(0, 8).toString('hex') === '89504e470d0a1a0a' && png.length > 8000, `${png.length} bytes`);
    const decoded = decodeQr(pngPath);
    ok('the QR on the downloaded card scans to her invite link (offline QR, end to end)', decoded === `${BASE}/invite?ref=${dinaCode}`, decoded || '(not decoded)');
    ok('message templates carry her code and link', (await page.locator('.gp-msg').first().textContent()).includes(`ref=${dinaCode}`));
    await shot(page, '02-circle-dashboard');
    await ctx.close();

    // ============================================================ 2. Invite landing page (a stranger)
    console.log('Invite landing page');
    ({ ctx, page } = await open(null, `/invite?ref=${dinaCode}`, { noAuth: true }));
    await page.waitForSelector('#gpGo', { timeout: 8000 });
    const inviteText = await page.textContent('#gpInvite');
    ok('the invited person is told who invited them, by first name only', inviteText.includes('Dina invited you') && !inviteText.includes('Auma') && !inviteText.includes('0772'));
    ok('the sign-up button carries the code', (await page.getAttribute('#gpGo', 'href')) === `/signup?ref=${encodeURIComponent(dinaCode)}`);
    ok('the code is remembered in the browser for sign-up (30 days)', await page.evaluate((c) => JSON.parse(localStorage.getItem('nx_ref')).code === c, dinaCode));
    ok('the trial and price come from the server rules', inviteText.includes('Free for 7 days') && inviteText.includes('UGX 20,000'));
    ok('invite page: header text is readable', await heroReadable(page));
    await shot(page, '03-invite-page');
    await ctx.close();
    ({ ctx, page } = await open(null, '/invite?ref=CIRCLE-ZZZZZ', { noAuth: true }));
    await page.waitForSelector('#gpGo');
    ok('a wrong code still gives a friendly plain invite page', (await page.textContent('#gpInvite')).includes('You are invited') && (await page.getAttribute('#gpGo', 'href')) === '/signup');
    await ctx.close();

    // ============================================================ 3. Recruit status, delayed approval, withdrawal
    console.log('Recruit tracking and withdrawal');
    const partnerRow = db.growthPartner.find((p) => p.code === dinaCode);
    // a recruit whose payment was sent 30 hours ago and still is not approved
    setOffset(-30 * HOUR);
    const owner = mkUser('Peter Owner');
    await growth.hooks.onSignup({ user: owner, code: dinaCode, ip: '41.1.1.1' });
    const store = { id: 'bs1', ownerId: owner.id, name: 'Peter Gadgets', district: 'kampala', phoneNumber: '0755000111', trialEndsAt: new Date(Date.now() + 5 * DAY), isPublished: true, deletedAt: null };
    db.store.push(store); await growth.hooks.onStoreCreated({ user: owner, store });
    await growth.hooks.onPaymentSubmitted({ payment: { id: 'bp1', reference: 'TXBROWSER1', amount: 20000, periodMonths: 1, submittedAt: clock() }, store });
    setOffset(0);
    // earnings already cleared, an old payout number, an account old enough: so the withdrawal itself can be tested
    partnerRow.joinedAt = new Date(Date.now() - 20 * DAY);
    Object.assign(partnerRow, { payoutNetwork: 'mtnMomo', payoutNumber: '256772123456', payoutName: 'Dina Auma', payoutNumberChangedAt: new Date(Date.now() - 5 * DAY) });
    db.growthReferral.push({ id: 'seedpaid', partnerId: partnerRow.id, stage: 'paid', source: 'link', recruitUserId: 'seedx', storeId: null, paidAt: new Date(Date.now() - 6 * DAY), riskDecision: 'clear', riskReasons: [], createdAt: new Date(Date.now() - 8 * DAY), signedUpAt: new Date(Date.now() - 8 * DAY) });
    db.growthCommission.push({ id: 'seedc', partnerId: partnerRow.id, referralId: 'seedpaid', paymentId: 'sp', type: 'first_payment', amount: 16000, status: 'available', note: 'seed', createdAt: new Date(Date.now() - 6 * DAY), clearsAt: new Date(Date.now() - 3 * DAY) });

    ({ ctx, page } = await open(dina, '/circle'));
    await page.waitForSelector('.gp-recruit', { timeout: 8000 });
    ok('the delayed recruit floats to the top and is marked as needing the recruiter', await page.locator('.gp-recruit.needs-you').count() >= 1 && (await page.textContent('#gpRecruits')).includes('longer than we aim'));
    ok('the banner counts recruits that need help', (await page.textContent('#gpRoot')).includes('1 recruit could use your help today'));
    ok('the recruiter sees no contact details of the recruit', !(await page.content()).includes('0755000111') && !(await page.content()).includes('petergadgets'));
    ok('circle dashboard: header text is readable', await heroReadable(page));
    await shot(page, '04-circle-delayed');
    await page.click('[data-ask]');
    ok('"Ask us to check" confirms to the recruiter and lands in the admin follow-ups', (await waitToast(page, /Thank you/)) && db.adminFollowUp.length === 1 && /Peter Gadgets/.test(db.adminFollowUp[0].title));
    ok('the NextaStore-pays-the-fee promise is shown on the money card', (await page.textContent('#gpMoney')).includes('NextaStore pays the mobile money fee'));
    await page.click('#gpWithdraw');
    await page.waitForSelector('#gpWf');
    ok('the withdrawal dialog opens prefilled with what can be withdrawn (UGX 16,000)', (await page.inputValue('#gpAmt')) === '16000');
    await page.click('#gpWf button[type=submit]');
    await page.waitForSelector('#gpMoney :text("Requested")', { timeout: 8000 });
    const wRow = db.growthWithdrawal[0];
    ok('the withdrawal is recorded with the 2-working-day deadline shown to the partner', wRow && wRow.amount === 16000 && wRow.needsSecondApproval === true && /be paid by/.test(await page.textContent('#gpMoney')));
    await page.click('#gpPayout'); await page.waitForSelector('#gpPf');
    await page.fill('#gpNum', '0701 555 666'); await page.fill('#gpNm', 'Dina Auma');
    await page.click('#gpPf button[type=submit]');
    await page.waitForSelector('#gpMoney :text("Withdrawals reopen")', { timeout: 8000 });
    ok('changing the payout number shows the safety pause', true);
    await shot(page, '05-circle-withdraw');
    await ctx.close();

    // ============================================================ 4. Crew: apply, approval, lead, offline, QR, Market Day
    console.log('Crew: application, leads, offline queue, QR, Market Days');
    const kofi = mkUser('Kofi Mensah');
    ({ ctx, page } = await open(kofi, '/crew'));
    await page.waitForSelector('#gpJoin', { timeout: 8000 });
    ok('the Crew pitch names itself as the field team next to the name', /NextaStore Crew\s*·\s*Field Team/.test((await page.textContent('.gp-hero .gp-kicker')).trim()), await page.textContent('.gp-hero .gp-kicker'));
    ok('the Crew pitch lists the rank ladder with server rates (25% to 40%)', /25% to 40%/.test(await page.textContent('#gpRoot')));
    await page.fill('#gpPhone', '0753 111 000');
    for (const t of ['kampala', 'wakiso', 'mukono', 'jinja']) await page.check(`#gpTerr input[value=${t}]`).catch(() => {});
    const picked = await page.locator('#gpTerr input:checked').count();
    ok('only 3 areas can be chosen', picked === 3, `picked ${picked}`);
    await page.fill('#gpNote', 'I know many traders in Owino.');
    await page.click('#gpJoin button[type=submit]');
    await sleep(600);
    ok('an application without ID photo or terms is refused with a clear message', /ID|terms/i.test(await page.textContent('#gpErr')));
    await page.setInputFiles('#gpId', { name: 'id.png', mimeType: 'image/png', buffer: PNG_1PX });
    await page.check('#gpTerms');
    await page.click('#gpJoin button[type=submit]');
    await page.waitForSelector(':text("We are reviewing your application")', { timeout: 8000 });
    const kp = db.growthPartner.find((p) => p.displayName === 'Kofi Mensah');
    ok('application saved as pending, ID stored through the private path (not a public URL)', kp && kp.status === 'applied' && kp.kycFileUrl.startsWith('private/growth-kyc/') && kp.territories.length === 3);
    await shot(page, '06-scout-pending');

    await growth.admin.approveScout('adminX', kp.id);
    await growth.admin.createCampaign('adminX', { title: 'Kampala Market Week', description: 'Pay this week', boostPercent: 20, district: 'kampala', startsAt: new Date(Date.now() - DAY), endsAt: new Date(Date.now() + 3 * DAY) });
    db.store.push({ id: 'bs2', ownerId: 'x', name: 'Mukono Mart', district: 'mukono', isPublished: true, deletedAt: null });
    await page.reload();
    await page.waitForSelector('#gpLead', { timeout: 8000 });
    const root = await page.textContent('#gpRoot');
    ok('an approved Crew member sees the lead form, Market Days, Trail Map and Share Studio', root.includes('Log a business you visited') && root.includes('Kampala Market Week') && root.includes('Trail map') && root.includes('Pitch kit'));
    ok('the Market Day shows its boost and that it is live', root.includes('+20% boost'));
    await page.fill('#gpLb', 'Mama Rose Shop'); await page.fill('#gpLp', '0772 555 111'); await page.fill('#gpLc', 'Rose');
    await page.click('#gpLead button[type=submit]');
    ok('logging a lead online claims it and says until when', (await waitToast(page, /Yours until/)) && db.growthReferral.some((r) => r.leadBusiness === 'Mama Rose Shop' && r.stage === 'lead'));
    await page.waitForSelector('#gpRecruits :text("Mama Rose Shop")');
    ok('the lead appears in the recruit list with its stage', (await page.textContent('#gpRecruits')).includes('Lead logged'));
    ok('crew dashboard: header text is readable', await heroReadable(page));
    await shot(page, '07-scout-dashboard');

    // offline
    await ctx.setOffline(true);
    await page.fill('#gpLb', 'Quiet Kiosk'); await page.fill('#gpLp', '0779 000 123');
    await page.click('#gpLead button[type=submit]');
    await page.waitForSelector('#gpQueue', { timeout: 8000 });
    ok('with no signal the lead is saved on the phone and the Crew member is told', (await page.textContent('#gpQueue')).includes('1 lead saved on your phone'));
    ok('nothing reached the server yet', !db.growthReferral.some((r) => r.leadBusiness === 'Quiet Kiosk'));
    ok('the queue lives in the browser', await page.evaluate(() => JSON.parse(localStorage.getItem('nx_lead_queue')).length === 1));
    await shot(page, '08-scout-offline-queue');
    await ctx.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    const synced = await until(() => db.growthReferral.some((r) => r.leadBusiness === 'Quiet Kiosk'), 8000);
    const synced2 = db.growthReferral.find((r) => r.leadBusiness === 'Quiet Kiosk');
    ok('when the signal returns the lead is sent automatically and keeps its offline capture time', synced && synced2.capturedOffline !== undefined && synced2.stage === 'lead');
    await until(async () => (await page.locator('#gpQueue').count()) === 0, 6000);
    ok('the queue empties once it is sent', (await page.locator('#gpQueue').count()) === 0 && await page.evaluate(() => JSON.parse(localStorage.getItem('nx_lead_queue') || '[]').length === 0));

    // QR
    await page.click('#gpQr'); await page.waitForSelector('#gpQrBox canvas');
    const qrPath = path.join(SHOTS, 'scout-qr.png'); await page.locator('#gpQrBox canvas').screenshot({ path: qrPath });
    ok('the Crew member\'s on-screen QR works with no CDN and scans to the invite link', decodeQr(qrPath) === `${BASE}/invite?ref=${kp.code}`, decodeQr(qrPath));
    await ctx.close();

    // ============================================================ 5. Admin console
    console.log('Admin console');
    const adm1 = mkUser('Admin One', { role: 'admin' }); const adm2 = mkUser('Admin Two', { role: 'admin' });
    ({ ctx, page } = await open(adm1, '/admin-growth#economics'));
    await page.waitForSelector('#agRoot .gp-card', { timeout: 8000 });
    ok('the Economics tab explains the cost guard and shows both windows', (await page.textContent('#agRoot')).includes('Is the program worth it?') && (await page.textContent('#agRoot')).includes('Since the program began'));
    await shot(page, '09-admin-economics');
    await page.click('a[data-tab=payouts]'); await page.waitForSelector('[data-open]', { timeout: 8000 });
    ok('the payout queue shows the request with its deadline and the two-admin warning', (await page.textContent('#agRoot')).includes('Dina Auma') && (await page.textContent('#agRoot')).includes('two admins'));
    await page.click('[data-open]'); await page.waitForSelector('#pApprove');
    ok('the payout dialog warns that NextaStore pays the fee and shows the estimate', (await page.textContent('dialog')).includes('NextaStore pays the mobile money fee'));
    await page.click('#pApprove'); await until(() => db.growthWithdrawal[0].status === 'approved', 5000);
    ok('the first admin approves', db.growthWithdrawal[0].status === 'approved');
    await page.click('[data-open]'); await page.waitForSelector('#pPaid');
    await page.fill('#pRef', 'MTN-77889'); await page.fill('#pFee', '650'); await page.click('#pPaid');
    ok('the same admin cannot pay a first payout (two-person rule shown as a message)', (await waitToast(page, /different admin/)) && db.growthWithdrawal[0].status === 'approved');
    await ctx.close();
    ({ ctx, page } = await open(adm2, '/admin-growth#payouts'));
    await page.waitForSelector('[data-open]', { timeout: 8000 }); await page.click('[data-open]'); await page.waitForSelector('#pPaid');
    await page.fill('#pRef', 'MTN-77889'); await page.fill('#pFee', '650'); await page.click('#pPaid');
    ok('a second admin pays it, and the REAL fee is recorded', await until(() => db.growthWithdrawal[0].status === 'paid', 5000) && db.growthWithdrawal[0].feeActual === 650);
    await ctx.close();
    ({ ctx, page } = await open(dina, '/circle')); await page.waitForSelector('#gpMoney');
    ok('the partner sees she has been paid', (await page.textContent('#gpMoney')).includes('UGX 16,000') && db.notification.some((n) => /You have been paid/.test(n.title)));
    await ctx.close();
    const eco = await growth.admin.economics();
    ok('the economics view now includes the real fee (650)', eco.lifetime.all.fees === 650);

    // ============================================================ 6. Seller-dashboard widget
    console.log('Seller-dashboard invite widget');
    const wale = mkUser('Wale Seller');
    ({ ctx, page } = await open(wale, '/__widget'));
    await page.waitForSelector('[data-growth-invite] .gp-card', { timeout: 8000 });
    ok('a seller who has not joined sees "Get my invite code"', (await page.textContent('[data-growth-invite]')).includes('Get my invite code'));
    await ctx.close();
    ({ ctx, page } = await open(dina, '/__widget'));
    await page.waitForSelector('[data-growth-invite] .gp-code-chip', { timeout: 8000 });
    const widgetText = await page.textContent('[data-growth-invite]');
    ok('a member sees her code, what is ready to withdraw, and share buttons', widgetText.includes(dinaCode) && widgetText.includes('Copy link'));
    await shot(page, '10-widget');
    await ctx.close();

    // ============================================================ result
    ok('no JavaScript errors on any page', errors.length === 0, `\n      ${errors.join('\n      ')}`);
    if (unknownApi.size) console.log(`  (note: pages also called ${unknownApi.size} other site endpoint(s) that the test server answers generically: ${[...unknownApi].join(', ')})`);
    await browser.close(); server.close();
    console.log(`\n${pass} passed, ${fail} failed   (screenshots: ${SHOTS})`);
    process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
