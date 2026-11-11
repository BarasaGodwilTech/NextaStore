/**
 * WIP 117 real-Chromium check against the real pages with a stubbed API (no database needed).
 * Run:  node scripts/tab-sync-referral-browser-test.js   (needs playwright)
 */
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const ROOT = require('path').join(__dirname, '..', '..');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };
const srv = http.createServer((req, res) => {
  let u = decodeURIComponent(req.url.split('?')[0]); if (u === '/') u = '/index';
  let f = path.join(ROOT, u); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f += '.html';
  if (!fs.existsSync(f)) { res.statusCode = 404; return res.end('nf'); }
  res.setHeader('Content-Type', types[path.extname(f)] || 'application/octet-stream'); res.end(fs.readFileSync(f));
}).listen(8097);
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (id) => `${b64({ alg: 'HS256' })}.${b64({ userId: id, exp: Math.floor(Date.now() / 1000) + 86400 })}.sig`;
const USER = { id: 'u1', name: 'Amina Nakato', role: 'buyer' };
let pass = 0, fail = 0; const ok = (n, c, x) => { c ? pass++ : fail++; console.log((c ? '  ok   ' : '  FAIL ') + n + (c ? '' : ' -> ' + JSON.stringify(x))); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
(async () => {
  const b = await chromium.launch();
  const mkctx = async () => {
    const ctx = await b.newContext({ viewport: { width: 1200, height: 800 } });
    await ctx.route('**/api/**', async (route) => {
      const url = route.request().url(); const h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
      const j = (o, s = 200) => route.fulfill({ status: s, contentType: 'application/json', headers: h, body: JSON.stringify(o) });
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: h });
      if (url.endsWith('/auth/config')) return j({ data: { email: { available: true } } });
      if (url.endsWith('/auth/login')) { const d = JSON.parse(route.request().postData()); return d.password === 'Passw0rd!' ? j({ token: jwt('u1'), user: USER }) : j({ message: 'Invalid email or password.' }, 401); }
      if (/\/user\/me$/.test(url)) return j({ data: USER });
      if (url.includes('/growth/resolve/')) return j({ data: { valid: true, firstName: 'Dina', program: 'circle' } });
      if (url.includes('/growth/rules')) return j({ data: { trialDays: 14, passPricePerMonth: 30000 } });
      return j({ data: [] });
    });
    return ctx;
  };
  const state = (p) => p.evaluate(() => ({ url: location.pathname + location.search, token: (typeof app !== 'undefined' && app.token) ? 'yes' : null, user: (typeof app !== 'undefined' && app.user && app.user.id) || null, ss: !!sessionStorage.getItem('nextastore_token'), ls: !!localStorage.getItem('nextastore_token') })).catch(() => null);
  const loginIn = async (p, remember) => { await p.goto('http://localhost:8097/login'); await p.waitForSelector('#email', { state: 'visible' }); await p.fill('#email', 'a@b.co'); if (remember) await p.check('#rememberMe'); await p.click('#emailContinueBtn'); await p.waitForSelector('#password', { state: 'visible' }); await p.fill('#password', 'Passw0rd!'); await p.press('#password', 'Enter'); await p.waitForURL(/marketplace/, { timeout: 8000 }); };

  for (const remember of [false, true]) {
    console.log(remember ? '\nWith "keep me signed in" ticked' : '\nWithout "keep me signed in"');
    const ctx = await mkctx();
    const A = await ctx.newPage(), B = await ctx.newPage(), G = await ctx.newPage();
    await B.goto('http://localhost:8097/login'); await B.waitForSelector('#email', { state: 'visible' });
    await G.goto('http://localhost:8097/marketplace'); await sleep(1200);
    ok('tab B (login page) and tab G (marketplace) start signed out', (await state(G)).token === null);
    await loginIn(A, remember); await sleep(1800);
    const sB = await state(B), sG = await state(G);
    ok('tab on the login page moves on by itself', /marketplace/.test(sB.url) && sB.user === 'u1', sB);
    ok('a public page open in another tab becomes signed in', sG.user === 'u1', sG);
    ok(`session lives in ${remember ? 'localStorage' : 'sessionStorage (per tab)'} in every tab`, remember ? (sB.ls && sG.ls) : (sB.ss && sG.ss && !sB.ls && !sG.ls), { sB, sG });
    // a brand-new tab opened later, on a page that needs a login
    const C = await ctx.newPage(); await C.goto('http://localhost:8097/orders'); await sleep(2200);
    const sC = await state(C);
    ok('a new tab opened on a protected page stays on it, signed in (no login screen)', /\/orders/.test(sC.url) && sC.user === 'u1', sC);
    const D = await ctx.newPage(); await D.goto('http://localhost:8097/login'); await sleep(2200);
    const sD = await state(D);
    ok('a new tab opened on the login page goes straight on', !/login/.test(sD.url) && sD.user === 'u1', sD);
    // sign out in tab A
    await A.evaluate(() => { app.confirm = async () => true; }); await A.evaluate(() => app.logout()); await sleep(2000);
    const after = await Promise.all([B, G, C, D].map(state));
    ok('signing out in one tab signs out every other tab', after.every(s => s && s.user === null), after);
    ok('protected tab went to the login screen', /login/.test(after[2].url), after[2]);
    await ctx.close();
  }

  console.log('\nDifferent person');
  { const ctx = await mkctx(); const A = await ctx.newPage(), B = await ctx.newPage();
    await B.goto('http://localhost:8097/marketplace'); await sleep(800);
    await loginIn(A, false); await sleep(1500);
    ok('guest tab adopted person u1', (await state(B)).user === 'u1');
    await ctx.close(); }

  console.log('\nReferral');
  { const ctx = await mkctx(); const P = await ctx.newPage();
    await P.goto('http://localhost:8097/invite?ref=CIRCLE-K7M3Q'); await P.waitForSelector('#gpGo', { timeout: 10000 });
    const href = await P.getAttribute('#gpGo', 'href');
    ok('invite page: "Open my free shop" link carries type=seller and the code', href === '/signup?type=seller&ref=CIRCLE-K7M3Q', href);
    await P.click('#gpGo'); await P.waitForSelector('#email', { state: 'visible' }); await sleep(800);
    ok('click lands on sign-up with Sell selected and seller wording', await P.isChecked('#accountTypeSeller') && /seller/i.test(await P.textContent('#authHeadline')));
    ok('the invite code is filled in and the group is open', (await P.inputValue('#referralCode')) === 'CIRCLE-K7M3Q' && await P.evaluate(() => document.getElementById('referralGroup').open));
    await P.goto('http://localhost:8097/signup'); await P.waitForSelector('#email', { state: 'visible' }); await sleep(500);
    ok('typing /signup later still starts on Sell while an invite is remembered', await P.isChecked('#accountTypeSeller'));
    await P.goto('http://localhost:8097/signup?type=buyer'); await P.waitForSelector('#email', { state: 'visible' }); await sleep(500);
    ok('but an explicit ?type=buyer is respected', await P.isChecked('#accountTypeBuyer'));
    await ctx.close(); }
  { const ctx = await mkctx(); const P = await ctx.newPage(); await P.goto('http://localhost:8097/signup'); await P.waitForSelector('#email', { state: 'visible' });
    ok('no invite: plain sign-up still starts on Shop', await P.isChecked('#accountTypeBuyer')); await ctx.close(); }
  console.log(`\n${pass} passed, ${fail} failed`); await b.close(); srv.close();
})().catch(e => { console.error(e); process.exit(1); });
