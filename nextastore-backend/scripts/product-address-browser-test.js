#!/usr/bin/env node
'use strict';
/*
 * Real-browser check of a product's own address (WIP 43):
 * nextastores.com/<store-slug>/<name>-<key>.
 *
 *   npm i --no-save playwright && npx playwright install chromium   (once)
 *   npm run test:product-address-browser        (CHROMIUM_PATH=... to pick a binary)
 *
 * The page a browser gets at that address is produced by the REAL src/seo.js and
 * src/slugs.js applied to the REAL product-detail.html (scripts/lib/
 * product-address-server.js), with only the database replaced by one fixture
 * product and one fixture store; the product / store / related-products API calls
 * are stubbed in the browser. So this proves what a person's browser does with the
 * HTML the API sends: the page's CSS and JS still load one folder deeper, the page
 * finds its product from the <meta> tags, the address bar never changes, the old
 * /product-detail?id=... links tidy their address bar and /p/<id> ends up at the
 * real address, neither trapping Back, an unknown address shows "not found", related products link to
 * their own addresses, the share actions hand out the address, and logging in
 * from a product page returns to it.
 * Does NOT prove: the Express routing itself (product-share-test.js runs the real
 * handlers), WhatsApp's own preview, or a real deployment's proxy rules.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const ROOT = path.resolve(__dirname, '..', '..');

function loadPlaywright() {
  try { return require('playwright'); } catch (e) { /* fall through */ }
  try { return require(path.join(require('child_process').execSync('npm root -g').toString().trim(), 'playwright')); } catch (e) { /* fall through */ }
  console.error('Playwright is not installed. Run: npm i --no-save playwright && npx playwright install chromium');
  process.exit(2);
}
const { chromium } = loadPlaywright();

let passed = 0, failed = 0;
function check(name, ok, detail) {
  if (ok) { passed++; console.log('PASS  ' + name); }
  else { failed++; console.log('FAIL  ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); }
}

const PID = 'cmg8x2k1a0003abcd5efgh6ij';           // key 5efgh6ij
const KEY = PID.slice(-8);
const ADDRESS = `/amina-crafts/handwoven-basket-${KEY}`;
const POT_ID = 'cmg8x2k1a0004clay0pot0002';         // a related product
const POT_ADDRESS = `/amina-crafts/clay-pot-${POT_ID.slice(-8)}`;
const STORE = { id: 'st1', slug: 'amina-crafts', name: 'Amina Crafts', district: 'Kampala', address: 'Plot 4 Bombo Rd', badges: [], logo: null };
const PRODUCT = { id: PID, storeId: 'st1', name: 'Handwoven Basket', description: 'A sturdy basket.', price: 45000, originalPrice: null, category: 'home', images: [], thumbnails: [], stock: 5, icon: 'fa-box' };
const OTHERS = [
  { id: 'cmg8x2k1a0005kitenge0bag1', name: 'Kitenge Bag', price: 30000, category: 'accessories' },
  { id: POT_ID, name: 'Clay Pot', price: 20000, category: 'home' },
  { id: PID, name: 'Handwoven Basket', price: 45000, category: 'home' }
];

const handleProductAddress = require('./lib/product-address-server')({
  root: ROOT,
  product: { id: PID, name: PRODUCT.name, description: PRODUCT.description, price: PRODUCT.price, stock: PRODUCT.stock, image: null, images: [], thumbnails: [] },
  store: { id: STORE.id, slug: STORE.slug, name: STORE.name, district: STORE.district, logo: null, seo: {}, isPublished: true }
});
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.ttf': 'font/ttf', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  if (handleProductAddress(req, res)) return;
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  let file = path.join(ROOT, (rel => rel === '/' ? 'index.html' : (fs.existsSync(path.join(ROOT, rel)) || path.extname(rel) ? rel : rel + '.html'))(urlPath));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

let PORT;
const origin = () => `http://127.0.0.1:${PORT}`;

async function newPage(browser, { mobile = false, share = false } = {}) {
  const ctx = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 }, isMobile: mobile, hasTouch: mobile, serviceWorkers: 'block', permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await ctx.newPage();
  const errors = [], bad = [];
  page.on('pageerror', e => errors.push(String(e)));
  // A failed or missing file of the SITE ITSELF (css, js, images, fonts) - what
  // breaks if the page's relative paths are not made root-relative.
  page.on('response', r => { const u = new URL(r.url()); if (u.origin === origin() && r.status() >= 400 && /^\/(?:[^/]+\/)*(?:css|js|assets)\//.test(u.pathname)) bad.push(`${r.status()} ${u.pathname}`); });
  await page.route('**/api/**', route => {
    const u = new URL(route.request().url());
    const p = u.pathname.replace(/^.*\/api/, '');
    const json = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(status === 200 ? { data } : { error: 'nope' }) });
    if (p.startsWith('/products/public/')) return p.endsWith(PID) ? json(PRODUCT) : json(null, 404);
    if (p.startsWith('/store/public/')) return json(STORE);
    if (p === '/products') return json(OTHERS);
    if (p.startsWith('/favorites/')) return json({ favorited: false });
    return json(null, 404);
  });
  if (share) await page.addInitScript(() => { window.__shared = null; navigator.share = async (d) => { window.__shared = d; }; });
  await page.addInitScript(() => { window.__opened = []; window.open = (u) => { window.__opened.push(String(u)); return null; }; });
  return { ctx, page, errors, bad };
}
const loaded = async (page) => {
  await page.waitForFunction(() => !document.documentElement.classList.contains('nx-loading'), null, { timeout: 15000 }).catch(() => {});
  await page.waitForSelector('#productContent:not(.hidden)', { timeout: 15000 });
};
const name = page => page.$eval('#productName', el => el.textContent.trim());

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  PORT = server.address().port;
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });

  // ===== 1. the product's own address ======================================
  {
    const { ctx, page, errors, bad } = await newPage(browser);
    const resp = await page.goto(origin() + ADDRESS);
    await loaded(page);
    check('the product\'s own address answers 200 and the page shows the product', resp.status() === 200 && await name(page) === 'Handwoven Basket');
    check('the page\'s own CSS, scripts and images all load from one folder deeper (none missing)', bad.length === 0, bad);
    check('the stylesheet really applied (the page is styled, not raw)', await page.evaluate(() => getComputedStyle(document.body).fontFamily !== 'Times New Roman' && document.styleSheets.length >= 3));
    check('the address bar is exactly the product\'s address - no redirect, no rewrite, no query', new URL(page.url()).pathname === ADDRESS && new URL(page.url()).search === '');
    check('the link-preview tags are in the page a browser receives (title with the price, canonical = this address)', await page.evaluate(([addr]) => {
      const m = p => document.querySelector(`meta[property="${p}"]`)?.content;
      return m('og:title') === 'Handwoven Basket \u2013 UGX 45,000' && document.querySelector('link[rel=canonical]')?.href === location.origin + addr && m('og:url') === location.origin + addr;
    }, [ADDRESS]));
    check('the breadcrumb links to the store at its own address', await page.$eval('.breadcrumb a[href="/amina-crafts"]', a => /Amina Crafts/.test(a.textContent)));

    // share actions hand out the address
    await page.click('#shareBtn');
    await page.click('[data-platform="whatsapp"]');
    check('Share > WhatsApp sends this product\'s address', await page.evaluate(([addr]) => window.__opened.some(u => u.startsWith('https://wa.me/') && u.includes(encodeURIComponent(location.origin + addr))), [ADDRESS]));
    await page.click('#shareBtn').catch(() => {});
    await page.click('[data-platform="copy"]');
    await page.waitForTimeout(150);
    check('Share > Copy link puts this product\'s address on the clipboard', await page.evaluate(() => navigator.clipboard.readText()) === origin() + ADDRESS);
    check('no uncaught page errors', errors.length === 0, errors);
    await ctx.close();
  }
  {
    const { ctx, page } = await newPage(browser, { mobile: true, share: true });
    await page.goto(origin() + ADDRESS);
    await loaded(page);
    await page.click('#shareBtn');
    check('phone share sheet gets the product\'s address', await page.evaluate(([addr]) => window.__shared && window.__shared.url === location.origin + addr, [ADDRESS]));
    await ctx.close();
  }

  // ===== 2. other spellings and the old addresses end at the real one ========
  {
    const { ctx, page } = await newPage(browser);
    await page.goto(origin() + `/amina-crafts/an-old-name-${KEY}?ref=wa`);
    await loaded(page);
    check('an old / edited name ends at the real address, query string kept', new URL(page.url()).pathname === ADDRESS && new URL(page.url()).search === '?ref=wa');
    await page.goto(origin() + `/p/${PID}?x=2`);
    await loaded(page);
    check('/p/<id> ends at the real address and keeps the query string', new URL(page.url()).pathname === ADDRESS && new URL(page.url()).search === '?x=2' && await name(page) === 'Handwoven Basket');
    await ctx.close();
  }
  {
    // Opening an OLD-style link: the page works on its id, then tidies the address
    // bar in place - so Back still goes to where you were.
    const { ctx, page } = await newPage(browser);
    await page.goto(origin() + '/marketplace');
    await page.goto(origin() + `/product-detail.html?id=${PID}&store=amina-crafts`);
    await loaded(page);
    await page.waitForFunction(([addr]) => location.pathname === addr, [ADDRESS], { timeout: 5000 }).catch(() => {});
    check('an old /product-detail?id=... link still loads its product', await name(page) === 'Handwoven Basket');
    check('...and the address bar is rewritten to the product\'s own address (no reload, no trace of ?id= or .html)', new URL(page.url()).pathname === ADDRESS && !/product-detail|[?&]id=/.test(page.url()));
    await page.goBack();
    await page.waitForTimeout(300);
    check('Back from there returns to the page before it (tidying the address added no history entry)', new URL(page.url()).pathname === '/marketplace', page.url());
    await ctx.close();
  }
  // ===== 3. unknown product ================================================
  {
    const { ctx, page, errors } = await newPage(browser);
    const resp = await page.goto(origin() + '/amina-crafts/no-such-thing-zzzzzzzz');
    await loaded(page);
    check('an unknown product address: a real 404 status, and the page shows its own "not found" state', resp.status() === 404 && await name(page) === 'Product Not Found');
    check('...with no script errors', errors.length === 0, errors);
    await ctx.close();
  }

  // ===== 4. related products link to their own addresses =====================
  {
    const { ctx, page } = await newPage(browser);
    await page.goto(origin() + ADDRESS);
    await loaded(page);
    await page.waitForSelector('.related-product-card[data-product-id]', { timeout: 10000 });
    const hrefs = await page.$$eval('.related-product-card[data-product-id]', els => els.map(e => e.dataset.productId));
    check('the related-products strip lists the other products (not this one)', hrefs.includes(POT_ID) && !hrefs.includes(PID), hrefs);
    await Promise.all([page.waitForURL(u => new URL(u).pathname === POT_ADDRESS, { timeout: 10000 }).catch(() => {}), page.click(`.related-product-card[data-product-id="${POT_ID}"]`)]);
    check('clicking a related product goes to THAT product\'s own address (/<store>/<name>-<key>)', new URL(page.url()).pathname === POT_ADDRESS, page.url());
    await ctx.close();
  }

  // ===== 5. logging in from a product page returns to it ====================
  {
    const { ctx, page } = await newPage(browser);
    await page.goto(origin() + ADDRESS);
    await loaded(page);
    await Promise.all([page.waitForURL(u => new URL(u).pathname === '/login', { timeout: 10000 }), page.evaluate(() => app.redirectToLogin())]);
    const redirect = new URL(page.url()).searchParams.get('redirect');
    check('redirectToLogin from a product page remembers BOTH parts of its address', redirect === ADDRESS.slice(1), redirect);
    const back = await page.evaluate(([r]) => safeRedirect(r, { id: 'u1', role: 'buyer' }, null), [redirect]);
    check('...and the login page would send the person back to exactly that address', back === ADDRESS, back);
    await ctx.close();
  }

  await browser.close();
  server.close();
  console.log(`\n${passed}/${passed + failed} browser checks passed.`);
  process.exitCode = failed ? 1 : 0;
})().catch(e => { console.error(e); server.close(); process.exit(2); });
