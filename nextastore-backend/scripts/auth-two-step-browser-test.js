/**
 * WIP 117 real-Chromium check against the real pages with a stubbed API (no database needed).
 * Run:  node scripts/auth-two-step-browser-test.js   (needs playwright)
 */
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const ROOT = require('path').join(__dirname, '..', '..');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.ico': 'image/x-icon', '.webp': 'image/webp' };
const srv = http.createServer((req, res) => {
  let u = decodeURIComponent(req.url.split('?')[0]); if (u === '/') u = '/index';
  let f = path.join(ROOT, u); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = f + '.html';
  if (!fs.existsSync(f)) { res.statusCode = 404; return res.end('nf'); }
  res.setHeader('Content-Type', types[path.extname(f)] || 'application/octet-stream'); res.end(fs.readFileSync(f));
}).listen(8099);
let pass = 0, fail = 0; const ok = (n, c, x) => { c ? pass++ : fail++; console.log((c ? '  ok   ' : '  FAIL ') + n + (c ? '' : ' -> ' + x)); };
(async () => {
  const b = await chromium.launch();
  const mk = async (vp, cfg) => {
    const ctx = await b.newContext({ viewport: vp }); const page = await ctx.newPage(); const posts = [];
    const errs = []; page.on('pageerror', e => errs.push(e.message));
    await page.route('**/api/**', async (route) => {
      const url = route.request().url(); const body = route.request().postData();
      const j = (o, s = 200) => route.fulfill({ status: s, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(o) });
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
      if (url.endsWith('/auth/config')) return j({ data: cfg || { googleSetupHint: true, email: { available: true } } });
      if (url.endsWith('/auth/login')) { posts.push(['login', JSON.parse(body)]); const d = JSON.parse(body); if (d.password === 'Passw0rd!') return j({ token: 'a.b.c', user: { id: 'u1', name: 'Amina Nakato', role: 'buyer' } }); return j({ message: 'Invalid email or password.' }, 401); }
      if (url.endsWith('/auth/signup')) { posts.push(['signup', JSON.parse(body)]); const d = JSON.parse(body); if (d.email === 'taken@example.com') return j({ message: 'An account with that email already exists.' }, 400); return j({ verificationRequired: true, email: d.email, emailSent: true }); }
      return j({ data: {} });
    });
    return { ctx, page, posts, errs };
  };
  // ---- login, desktop
  let { page, posts, errs } = await mk({ width: 1280, height: 860 });
  await page.goto('http://localhost:8099/login'); await page.waitForSelector('#email', { state: 'visible', timeout: 15000 }); await page.waitForTimeout(1500);
  ok('login: step 1 shows email, not password', await page.isVisible('#email') && !(await page.isVisible('#password')));
  await page.screenshot({ path: 'r-login1.png' });
  await page.click('#emailContinueBtn');
  ok('login: empty email is refused inline', (await page.textContent('#emailForm .form-error')).length > 0 && !(await page.isVisible('#password')));
  await page.fill('#email', 'nope'); await page.click('#emailContinueBtn');
  ok('login: bad email format is refused', /valid email/.test(await page.textContent('#emailForm .form-error')));
  await page.fill('#email', 'amina@example.com'); await page.click('#emailContinueBtn');
  await page.waitForSelector('#password', { state: 'visible' });
  await page.waitForTimeout(150);
  ok('login: step 2 shows chip with email + password focused', (await page.textContent('[data-chip-email]')) === 'amina@example.com' && await page.evaluate(() => document.activeElement.id) === 'password');
  ok('login: headline changed', (await page.textContent('#authHeadline')) === 'Enter your password');
  ok('login: forgot link carries the email', (await page.getAttribute('[data-forgot-link]', 'href')).includes('amina%40example.com'));
  await page.screenshot({ path: 'r-login2.png' });
  await page.fill('#password', 'wrong'); await page.press('#password', 'Enter'); await page.waitForTimeout(500);
  ok('login: wrong password shows inline error under the box', /Invalid email/.test(await page.textContent('#loginForm .form-error')));
  await page.click('[data-change-email]'); await page.waitForTimeout(100);
  ok('login: Change goes back to step 1 with email kept', await page.isVisible('#email') && (await page.inputValue('#email')) === 'amina@example.com');
  await page.click('#emailContinueBtn'); await page.waitForSelector('#password', { state: 'visible' }); await page.keyboard.press('Escape');
  ok('login: Esc goes back too', await page.isVisible('#email'));
  await page.click('#emailContinueBtn'); await page.waitForSelector('#password', { state: 'visible' });
  await page.fill('#password', 'Passw0rd!'); await page.press('#password', 'Enter'); await page.waitForTimeout(600);
  ok('login: correct password posts email+password+rememberMe', posts.some(p => p[0] === 'login' && p[1].email === 'amina@example.com' && p[1].password === 'Passw0rd!' && p[1].rememberMe === false), JSON.stringify(posts));
  ok('login: no page errors', errs.length === 0, errs.join('|'));
  // ---- signup desktop
  ({ page, posts, errs } = await mk({ width: 1280, height: 860 }));
  await page.goto('http://localhost:8099/signup?type=seller'); await page.waitForSelector('#email', { state: 'visible', timeout: 15000 }); await page.waitForTimeout(1500);
  ok('signup: Sell preselected via ?type=seller and headline matches', await page.isChecked('#accountTypeSeller') && /seller/i.test(await page.textContent('#authHeadline')));
  await page.screenshot({ path: 'r-signup1.png' });
  await page.fill('#email', 'taken@example.com'); await page.click('#emailContinueBtn'); await page.waitForSelector('#name', { state: 'visible' });
  ok('signup: step 2 shows name + password only (no confirm box)', await page.isVisible('#name') && await page.isVisible('#password') && !(await page.$('#confirmPassword')));
  ok('signup: headline + progress follow the step', (await page.textContent('#authHeadline')) === 'Almost done' && (await page.textContent('#progressLabel')) === 'Step 2 of 2');
  await page.screenshot({ path: 'r-signup2.png' });
  await page.click('#signupSubmitBtn');
  ok('signup: empty name + password refused', (await page.textContent('#name + .form-error')).length > 0);
  await page.fill('#name', 'Amina Nakato'); await page.fill('#password', 'short'); await page.click('#signupSubmitBtn');
  ok('signup: short password refused inline, nothing posted', posts.length === 0 && /8 characters/.test(await page.textContent('.password-input-wrapper ~ .form-error')));
  await page.fill('#password', 'Str0ngPassw0rd!'); await page.click('#signupSubmitBtn'); await page.waitForTimeout(500);
  ok('signup: existing email shows "sign in instead" note with prefilled link', await page.isVisible('#signupExists') && (await page.getAttribute('[data-signin-link]', 'href')).includes('taken%40example.com'));
  await page.screenshot({ path: 'r-signup3.png' });
  await page.click('#signupExists [data-change-email]'); await page.fill('#email', 'new@example.com'); await page.click('#emailContinueBtn'); await page.waitForSelector('#name', { state: 'visible' });
  ok('signup: note is gone on the next try', !(await page.isVisible('#signupExists')));
  await page.fill('#name', 'Amina Nakato'); await page.fill('#password', 'Str0ngPassw0rd!'); await page.click('#signupSubmitBtn'); await page.waitForSelector('#checkEmail', { state: 'visible' });
  const sp = posts.filter(p => p[0] === 'signup').pop();
  ok('signup: posts name, email, password, accountType=seller', sp && sp[1].name === 'Amina Nakato' && sp[1].email === 'new@example.com' && sp[1].accountType === 'seller' && !('confirmPassword' in sp[1]), JSON.stringify(sp));
  ok('signup: inbox panel shown', /new@example.com/.test(await page.textContent('[data-check-email]')));
  await page.screenshot({ path: 'r-signup4.png' });
  await page.click('#changeEmailBtn'); await page.waitForTimeout(100);
  ok('signup: "Use a different email" returns to an empty step 1', await page.isVisible('#email') && (await page.inputValue('#email')) === '');
  ok('signup: no page errors', errs.length === 0, errs.join('|'));
  // ---- email service down: Google still reachable, email form locked
  ({ page } = await mk({ width: 1280, height: 860 }, { googleSetupHint: true, email: { available: false } }));
  await page.goto('http://localhost:8099/signup'); await page.waitForSelector('#emailDown:not([hidden])', { timeout: 15000 });
  ok('signup: email down locks the email form', await page.isDisabled('#email') && await page.isDisabled('#emailContinueBtn'));
  // ---- phone
  for (const [f, name] of [['login', 'm-login1'], ['signup', 'm-signup1']]) {
    ({ page } = await mk({ width: 390, height: 844 })); await page.goto('http://localhost:8099/' + f); await page.waitForSelector('#email', { state: 'visible', timeout: 15000 }); await page.waitForTimeout(1500);
    ok(`${f} phone: no horizontal scroll`, await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await page.screenshot({ path: name + '.png', fullPage: true });
    await page.fill('#email', 'amina@example.com'); await page.click('#emailContinueBtn'); await page.waitForTimeout(500);
    await page.screenshot({ path: name.replace('1', '2') + '.png', fullPage: true });
  }
  console.log(`\n${pass} passed, ${fail} failed`); await b.close(); srv.close();
})().catch(e => { console.error(e); process.exit(1); });
