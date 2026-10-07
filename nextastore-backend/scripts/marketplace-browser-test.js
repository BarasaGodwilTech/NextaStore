#!/usr/bin/env node
'use strict';
/*
 * Real-browser check of marketplace.html (WIP 50, hero updated in WIP 53): the REAL page, css and js, served from the
 * project folder, with a fake API in front of it (page.route) so no database is needed.
 *
 *   npm i --no-save playwright && npx playwright install chromium   (once)
 *   npm run test:marketplace-browser        (CHROMIUM_PATH=... to pick a binary)
 *
 * Layout (320 / 375 / 768 / 1024 / 1440 px) with hostile data: a 100-character store name, a 70-character
 * unbroken name, 5 badges, an 800-character description, 10 categories, 1.25M followers, a UGX 999 billion
 * price, service / digital / sold-out / discounted / broken-photo products. Fails on: anything spilling
 * past its card, sideways page scroll, uneven card heights in a row, wrong column count, a last row that
 * is not full, or any uncaught page error.
 * Behaviour: category chip + URL, search with no results + "Clear", "Show more products", a failed
 * request showing "Try again" (and the other section still loading), broken images falling back.
 *
 * Font Awesome and Google Fonts are blocked in the test (no network), so icon widths are approximate.
 */
const fs = require('fs');
const http = require('http');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
function loadPlaywright() {
  try { return require('playwright'); } catch (e) { /* fall through */ }
  try { return require(path.join(require('child_process').execSync('npm root -g').toString().trim(), 'playwright')); } catch (e) { /* fall through */ }
  console.error('Playwright is not installed. Run: npm i --no-save playwright && npx playwright install chromium');
  process.exit(2);
}
const { chromium } = loadPlaywright();

const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

// ---------- fake data ----------
const LONG = 'The Very Long Named Handmade Kampala Craft and Leather Goods Collective of Central Uganda Limited Edition';
const BADGES = [
  { label: 'Verified seller', tone: 'verified', icon: 'fa-check', shortLabel: 'Verified' },
  { label: 'Gold commitment 12 months verified by NextaStore', tone: 'gold', icon: 'fa-award', shortLabel: 'Gold' },
  { label: 'Platinum commitment 24 months', tone: 'platinum', icon: 'fa-gem', shortLabel: 'Platinum' },
  { label: 'Fast responder', tone: 'ready', icon: 'fa-bolt', shortLabel: 'Fast' },
  { label: 'Top seller in Uganda, Kampala Region', tone: 'gold', icon: 'fa-star', shortLabel: 'Top' },
];
const CATS = ['clothing', 'phones', 'electronics', 'shoes', 'food', 'home', 'vehicles', 'beauty', 'accessories', 'appliances'];
const img = c => `http://localhost:4000/img/${c}.svg`;
function store(i) {
  const s = { id: 's' + i, slug: 'store-' + i, name: 'Store ' + i, description: 'Quality goods from Kampala.', district: 'Kampala',
    logo: i % 2 ? img('0b3b2b') : null, banner: i % 3 === 0 ? img('01b075') : null, bannerColor: ['#01B075', '#D9534F', '#0B3B2B', '#FFB038'][i % 4],
    followers: i * 7, productCount: i * 3, badges: [], tier: null, categories: i % 2 ? ['food'] : [] };
  const k = i % 6;
  if (k === 0) Object.assign(s, { name: LONG, description: 'We make and sell things. '.repeat(35), district: 'Kampala Central Division, Nakasero, Plot 14 Kyagwe Road, Opposite the Old Taxi Park',
    followers: 1250000, productCount: 99999, badges: BADGES, tier: { tone: 'platinum', label: 'Platinum', shortLabel: 'Platinum', icon: 'fa-gem' }, categories: CATS,
    logo: 'http://localhost:4000/img/broken.png', banner: 'http://localhost:4000/img/broken2.png' });
  else if (k === 1) Object.assign(s, { name: 'A'.repeat(70), description: '', badges: BADGES.slice(0, 2), tier: { tone: 'gold', label: 'Gold', shortLabel: 'Gold', icon: 'fa-award' }, categories: CATS.slice(0, 3), district: '' });
  else if (k === 2) Object.assign(s, { name: 'Emoji \u{1F9F5} Threads', followers: 12345, productCount: 0, badges: BADGES.slice(0, 1), categories: [], logo: null, banner: null });
  else if (k === 3) Object.assign(s, { name: 'Short', description: 'x', followers: 0, productCount: 1, categories: ['unknown_old_id', 'other'], bannerColor: 'javascript:evil' });
  return s;
}
function product(i) {
  const k = i % 8;
  const p = { id: 'p' + i, name: 'Product ' + i, price: 25000 + i * 100, originalPrice: null, stock: 5, listingType: 'physical', icon: 'fa-box',
    thumbnail: i % 2 ? img('c1d0ca') : null, storeName: 'Store ' + (i % 9), storeSlug: 'store-' + (i % 9), sellerTier: null };
  if (k === 0) Object.assign(p, { name: 'Extra long product name with lots and lots of words that definitely cannot fit on two lines at all, ever', storeName: LONG, price: 999999999999, originalPrice: 1999999999999, sellerTier: { tone: 'platinum', label: 'Platinum seller', shortLabel: 'Platinum', icon: 'fa-gem' } });
  else if (k === 1) Object.assign(p, { name: 'B'.repeat(60), price: 12345678, originalPrice: 15000000, sellerTier: { tone: 'gold', label: 'Gold', shortLabel: 'Gold', icon: 'fa-award' } });
  else if (k === 2) Object.assign(p, { name: 'Plumbing repair', listingType: 'service', price: 50000, storeName: 'Handy Co' });
  else if (k === 3) Object.assign(p, { name: 'E-book guide', listingType: 'digital', price: 10000, sellerTier: { tone: 'verified', label: 'Verified', shortLabel: 'Verified', icon: 'fa-circle-check' } });
  else if (k === 4) Object.assign(p, { name: 'Sold out item', stock: 0, price: 8000 });
  else if (k === 5) Object.assign(p, { name: 'Broken photo', thumbnail: 'http://localhost:4000/img/nope.png', icon: 'fa-shirt' });
  else if (k === 6) Object.assign(p, { name: 'Discounted', price: 9000, originalPrice: 10000 });
  return p;
}
const STORES = Array.from({ length: 60 }, (_, i) => store(i + 1));
const PRODUCTS = Array.from({ length: 300 }, (_, i) => product(i + 1));
const TOTAL_STORES = 1248, TOTAL_PRODUCTS = 52310;
function paged(arr, total, q) {
  const page = Number(q.get('page') || 1), limit = Number(q.get('limit') || 12), start = (page - 1) * limit;
  const data = start < total ? Array.from({ length: limit }, (_, k) => ({ ...arr[(start + k) % arr.length], id: `${arr[(start + k) % arr.length].id}-${page}-${k}` })) : [];
  return { data, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
}
const MODE = { failStores: false };
const LOG = { stores: [], products: [], fav: [] };
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' };
const json = (route, status, body) => route.fulfill({ status, headers: CORS, contentType: 'application/json', body: JSON.stringify(body) });
async function fakeApi(route, request) {
  const u = new URL(request.url()), q = u.searchParams;
  if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
  if (u.pathname.startsWith('/img/')) {
    if (/broken|nope/.test(u.pathname)) return route.fulfill({ status: 404, headers: CORS, body: '' });
    const col = '#' + u.pathname.split('/').pop().replace('.svg', '');
    return route.fulfill({ status: 200, headers: CORS, contentType: 'image/svg+xml', body: `<svg xmlns='http://www.w3.org/2000/svg' width='200' height='200'><rect width='200' height='200' fill='${col}'/><circle cx='100' cy='100' r='50' fill='white' opacity='.5'/></svg>` });
  }
  const none = q.get('q') === 'zzzz';
  if (u.pathname.endsWith('/store/public/all')) {
    LOG.stores.push(u.search);
    if (MODE.failStores) return json(route, 500, { error: 'boom' });
    return json(route, 200, none ? { data: [], pagination: { page: 1, limit: 12, total: 0, pages: 1 } } : paged(STORES, TOTAL_STORES, q));
  }
  if (u.pathname.endsWith('/favorites/check')) {
    LOG.fav.push('CHECK ' + q.get('ids'));
    return json(route, 200, { data: { favorited: String(q.get('ids') || '').split(',').filter(id => /^p3-/.test(id)) } });
  }
  if (/\/favorites\/[^/]+$/.test(u.pathname)) { LOG.fav.push(request.method() + ' ' + u.pathname.split('/').pop()); return json(route, 200, { data: { favorited: request.method() === 'POST' } }); }
  if (u.pathname.endsWith('/products/public')) LOG.products.push(u.search);
  if (u.pathname.endsWith('/products/public')) return json(route, 200, none ? { data: [], pagination: { page: 1, limit: 12, total: 0, pages: 1 } } : paged(PRODUCTS, TOTAL_PRODUCTS, q));
  return json(route, 401, { error: 'Unauthorized' });
}

async function openPage(browser, port, width, pathAndQuery = '/marketplace.html') {
  const ctx = await browser.newContext({ viewport: { width, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.route(/^http:\/\/localhost:4000\/.*/, fakeApi);
  await page.route(url => { const h = new URL(url).host; return h !== `127.0.0.1:${port}` && h !== 'localhost:4000'; }, r => r.abort());
  await page.goto(`http://127.0.0.1:${port}${pathAndQuery}`);
  await page.waitForFunction(() => !document.documentElement.classList.contains('nx-loading'), null, { timeout: 15000 });
  return { ctx, page, errors };
}

const MEASURE = () => {
  const out = { clipped: [] };
  document.querySelectorAll('#storesGrid .mk-store, #trendingProducts .mk-product').forEach(c => {
    const cr = c.getBoundingClientRect();
    c.querySelectorAll('*').forEach(el => {
      const b = el.getBoundingClientRect();
      if (b.width && !el.closest('.mk-store-link') && (b.right > cr.right + 0.5 || b.left < cr.left - 0.5)) out.clipped.push(c.className.split(' ')[0] + '>' + String(el.className.baseVal ?? el.className ?? el.tagName).slice(0, 30));
    });
  });
  out.pageScroll = document.documentElement.scrollWidth > window.innerWidth + 1;
  const rows = sel => { const m = {}; document.querySelectorAll(sel).forEach(c => { const r = c.getBoundingClientRect(), k = Math.round(r.top + scrollY); (m[k] = m[k] || []).push(Math.round(r.height)); }); return Object.values(m); };
  const sr = rows('#storesGrid .mk-store'), pr = rows('#trendingProducts .mk-product');
  out.storeUneven = sr.filter(a => new Set(a).size > 1).length; out.productUneven = pr.filter(a => new Set(a).size > 1).length;
  out.storeCols = sr[0] ? sr[0].length : 0; out.productCols = pr[0] ? pr[0].length : 0;
  out.storeLastFull = sr.length && sr[sr.length - 1].length === out.storeCols; out.productLastFull = pr.length && pr[pr.length - 1].length === out.productCols;
  out.heroSpill = [...document.querySelectorAll('.hero-wrap *')].filter(el => { const b = el.getBoundingClientRect(); return b.width && !el.closest('[hidden], .hero-collage, .nexi-starters') && (b.right > innerWidth + 1 || b.left < -1); }).length;
  out.heroTiles = document.querySelectorAll('#heroCollage .hero-stall:not(.is-skel)').length;
  const col = document.getElementById('heroCollage').getBoundingClientRect(); out.collageSpill = col.right > innerWidth + 1 || col.left < -1;
  out.chatThere = !!document.querySelector('#heroChat .nexi-composer') && !document.getElementById('heroSearchForm');
  out.storeCount = document.querySelectorAll('#storesGrid .mk-store').length; out.productCount = document.querySelectorAll('#trendingProducts .mk-product').length;
  return out;
};
const EXPECT = { 320: [2, 2], 375: [2, 2], 768: [3, 4], 1024: [4, 4], 1440: [5, 6] }; // [store cols, product cols]

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--no-sandbox'] });
  let bad = 0;
  const check = (ok, label) => { if (!ok) bad++; console.log(`${ok ? 'ok  ' : 'BAD '} ${label}`); };

  for (const w of [320, 375, 768, 1024, 1440]) {
    const { ctx, page, errors } = await openPage(browser, port, w);
    await page.waitForSelector('#storesGrid .mk-store'); await page.waitForTimeout(400);
    const r = await page.evaluate(MEASURE);
    const [sc, pc] = EXPECT[w];
    const ok = !r.heroSpill && !r.collageSpill && r.chatThere && r.heroTiles === 4 && !r.clipped.length && !r.pageScroll && !r.storeUneven && !r.productUneven && r.storeCols === sc && r.productCols === pc && r.storeLastFull && r.productLastFull && !errors.length;
    check(ok, `layout ${String(w).padStart(4)}px  stores ${r.storeCount} (${r.storeCols} cols)  products ${r.productCount} (${r.productCols} cols)` +
      (r.clipped.length ? `  spills: ${[...new Set(r.clipped)].slice(0, 5).join(', ')}` : '') + (r.pageScroll ? '  PAGE-SCROLL' : '') + (r.heroSpill ? `  hero spills past the screen (${r.heroSpill})` : '') + (r.heroTiles !== 4 ? `  hero store cards ${r.heroTiles}` : '') + (r.collageSpill ? '  store-card row spills' : '') + (!r.chatThere ? '  hero chat missing' : '') +
      (r.storeUneven || r.productUneven ? '  uneven rows' : '') + (!r.storeLastFull || !r.productLastFull ? '  last row not full' : '') + (errors.length ? `  JS ERROR: ${errors[0]}` : ''));
    await ctx.close();
  }

  // ---- behaviour at phone width ----
  {
    const { ctx, page, errors } = await openPage(browser, port, 375);
    await page.waitForSelector('#storesGrid .mk-store');
    check(await page.evaluate(() => ['heroStoreCount', 'heroProductCount'].every(id => /\d/.test(document.getElementById(id).textContent) && !document.getElementById(id).classList.contains('is-pending'))), 'hero numbers come from the API (not fixed text)');
    check((await page.evaluate(() => document.getElementById('viewAllStoresLink').getAttribute('href'))) === '/stores', 'Featured stores header links to /stores');
    check((await page.evaluate(() => document.getElementById('storesViewAll').textContent.trim())).startsWith('View all 1,248 stores'), 'bottom button says how many stores there are');

    // broken photos fall back
    await page.waitForTimeout(600);
    const broken = await page.evaluate(() => [...document.querySelectorAll('.mk-store img[data-fallback], .mk-product img[data-fallback]')].filter(i => i.complete && i.naturalWidth === 0).length);
    check(broken === 0, 'broken store/product photos are replaced by the colour / initial / icon');

    // category chip -> filter, title, URL, directory link
    await page.click('.cat-tile[data-category="food"]'); await page.waitForTimeout(700);
    const f = await page.evaluate(() => ({ url: location.search, title: document.getElementById('storesTitle').textContent, ptitle: document.getElementById('productsTitle').textContent, href: document.getElementById('viewAllStoresLink').getAttribute('href') }));
    check(f.url === '?category=food' && /Food/.test(f.title) && /Food/.test(f.ptitle) && f.href === '/stores?category=food', `category chip filters both sections, keeps the URL and the /stores link (${f.url} | ${f.title} | ${f.href})`);
    await page.click('#catFilterClear'); await page.waitForTimeout(700);
    check(await page.evaluate(() => location.search === '' && document.getElementById('storesTitle').textContent === 'Featured stores'), 'clearing the category restores the page');

    // search with no results -> empty state with a working Clear
    await page.fill('#marketplaceSearch', 'zzzz'); await page.waitForTimeout(900);
    check(await page.evaluate(() => /No stores match/.test(document.getElementById('storesGrid').textContent) && /No products match/.test(document.getElementById('trendingProducts').textContent) && !!document.querySelector('[data-mk-action="clear"]')), 'no-result search shows empty states with a Clear button');
    await page.click('#storesGrid [data-mk-action="clear"]'); await page.waitForTimeout(800);
    check(await page.evaluate(() => document.querySelectorAll('#storesGrid .mk-store').length > 0 && document.getElementById('marketplaceSearch').value === ''), 'Clear brings every store back and empties the search box');

    // show more
    const before = await page.evaluate(() => document.querySelectorAll('#trendingProducts .mk-product').length);
    await page.click('#productsLoadMore'); await page.waitForTimeout(900);
    const after = await page.evaluate(() => ({ n: document.querySelectorAll('#trendingProducts .mk-product').length, ids: new Set([...document.querySelectorAll('#trendingProducts .mk-product')].map(a => a.dataset.productId)).size, note: document.getElementById('productsShown').textContent }));
    check(after.n === before + 12 && after.ids === after.n && /Showing 24 of 52,310/.test(after.note), `"Show more products" appends one more page without duplicates (${before} -> ${after.n}; ${after.note})`);

    // cards are real links
    check(await page.evaluate(() => { const a = document.querySelector('#storesGrid .mk-store-link'), p = document.querySelector('#trendingProducts .mk-product-link'); return /^\/store-\d+$/.test(a.getAttribute('href')) && /^\/store-\d+\//.test(p.getAttribute('href')) && !document.querySelector('a button, a a') && !!document.querySelector('.mk-product .mk-fav'); }), 'store and product cards are links, and the heart button is not inside a link');
    check(!errors.length, 'no uncaught page errors during the walk-through' + (errors.length ? `: ${errors[0]}` : ''));
    await ctx.close();
  }

  // ---- hero (desktop): store cards + the Nexi chat (the old hero search was replaced by the chat) ----
  {
    const { ctx, page, errors } = await openPage(browser, port, 1440);
    await page.waitForSelector('#heroCollage .hero-stall:not(.is-skel)'); await page.waitForTimeout(500);
    const h = await page.evaluate(() => ({ imgsBroken: [...document.querySelectorAll('#heroCollage img')].filter(i => i.complete && i.naturalWidth === 0).length,
      hrefs: [...document.querySelectorAll('#heroCollage a.hero-stall')].every(a => /^\/store-\d+$/.test(a.getAttribute('href'))), actionsHidden: getComputedStyle(document.querySelector('.hero-actions')).display === 'none',
      chat: !!document.querySelector('#heroChat .nexi-composer textarea') && document.querySelectorAll('#heroChat .nexi-chip').length >= 5, noSearch: !document.getElementById('heroSearchForm') && !document.querySelector('.hero-chip') }));
    check(h.hrefs && !h.imgsBroken && h.actionsHidden && h.chat && h.noSearch, 'desktop hero: 4 store cards that link to their stores, Nexi chat with starters (hero search + category chips removed)');
    const awning = await page.evaluate(() => { const a = document.querySelector('.hero-stall .hero-stall-awning'); const cs = getComputedStyle(a); return /repeating-linear-gradient/.test(cs.backgroundImage) && getComputedStyle(a.closest('.hero-stall')).getPropertyValue('--bc').trim().startsWith('#'); });
    check(awning, 'each store card gets an awning in its own banner colour');
    check(!errors.length, 'no page errors from the hero' + (errors.length ? ': ' + errors[0] : ''));
    await ctx.close();
  }
  {
    const { ctx, page } = await openPage(browser, port, 375);
    await page.waitForSelector('#heroCollage .hero-stall:not(.is-skel)');
    check(await page.evaluate(() => getComputedStyle(document.querySelector('.hero-actions')).display === 'flex' && !!document.querySelector('#heroChat .nexi-composer') && getComputedStyle(document.getElementById('heroCollage')).overflowX === 'auto'), 'phone hero: Nexi chat + buttons, store cards in a swipeable row');
    await ctx.close();
  }

  // ---- sort, price range, filter chips (phone width) ----
  {
    const { ctx, page, errors } = await openPage(browser, port, 375);
    await page.waitForSelector('#trendingProducts .mk-product');
    const storeReqs = LOG.stores.length;
    await page.selectOption('#productsSort', 'price-low'); await page.waitForTimeout(800);
    check(await page.evaluate(() => location.search === '?sort=price-low' && document.getElementById('productsTitle').textContent === 'Products: lowest price first') && /sort=price-low/.test(LOG.products[LOG.products.length - 1]) && LOG.stores.length === storeReqs,
      'sorting re-queries products only (stores untouched), updates the title and the URL');
    check(await page.evaluate(() => document.getElementById('heroCollage').querySelectorAll('.hero-stall:not(.is-skel)').length === 4), 'the hero store cards stay put when the product sort changes');

    await page.fill('#priceMin', '10,000'); await page.fill('#priceMax', '50000'); await page.click('#priceForm button'); await page.waitForTimeout(800);
    const last = LOG.products[LOG.products.length - 1];
    check(/minPrice=10000/.test(last) && /maxPrice=50000/.test(last) && await page.evaluate(() => /min=10000/.test(location.search) && /max=50000/.test(location.search) && /UGX\s10,000\s*\u2013\s*UGX\s50,000/.test(document.getElementById('activeFilters').textContent) && /found/.test(document.getElementById('productsCount').textContent)),
      'price range filters the products, shows a chip, and is kept in the URL');
    await page.fill('#priceMin', '90000'); await page.fill('#priceMax', '1000'); await page.click('#priceForm button'); await page.waitForTimeout(800);
    check(/minPrice=1000/.test(LOG.products[LOG.products.length - 1]) && /maxPrice=90000/.test(LOG.products[LOG.products.length - 1]), 'a reversed price range is put the right way round');
    await page.click('#activeFilters [data-mk-action="clear-price"]'); await page.waitForTimeout(800);
    check(await page.evaluate(() => document.getElementById('activeFilters').hidden && document.getElementById('priceMin').value === '' && !/min=/.test(location.search)), 'removing the price chip clears the range');

    await page.click('.cat-tile[data-category="food"]'); await page.fill('#marketplaceSearch', 'shirt'); await page.waitForTimeout(1000);
    const chips = await page.evaluate(() => [...document.querySelectorAll('#activeFilters .mk-fchip')].map(b => b.textContent.trim()));
    check(chips.length === 2 && await page.evaluate(() => !!document.querySelector('#activeFilters .mk-fclear')), `search + category show as two removable chips with "Clear all" (${chips.join(' | ').replace(/\s+/g, ' ')})`);
    await page.click('#activeFilters .mk-fclear'); await page.waitForTimeout(900);
    check(await page.evaluate(() => document.getElementById('activeFilters').hidden && document.getElementById('marketplaceSearch').value === '' && document.getElementById('storesTitle').textContent === 'Featured stores'), '"Clear all" resets search, category and price');
    check(!errors.length, 'no page errors from sort / price / chips' + (errors.length ? ': ' + errors[0] : ''));
    await ctx.close();
  }

  // ---- hearts ----
  {
    const { ctx, page, errors } = await openPage(browser, port, 1280);
    await page.waitForSelector('#trendingProducts .mk-product');
    check((await page.evaluate(() => document.querySelectorAll('.mk-fav').length)) >= 12 && !LOG.fav.length, 'every product card has a heart, and a signed-out visitor makes no favorites requests');
    await page.evaluate(() => { app.token = 'test-token'; });
    await page.selectOption('#productsSort', 'newest'); await page.waitForTimeout(900);
    const hearts = await page.evaluate(() => ({ on: document.querySelectorAll('.mk-fav.is-favorite').length, ids: [...document.querySelectorAll('.mk-fav.is-favorite')].every(b => /^p3-/.test(b.dataset.fav)) }));
    check(LOG.fav.some(l => l.startsWith('CHECK')) && hearts.on >= 1 && hearts.ids, `signed in: one /favorites/check request paints the saved hearts (${hearts.on})`);
    const target = await page.evaluate(() => document.querySelector('.mk-fav:not(.is-favorite)').dataset.fav);
    await page.click(`.mk-fav[data-fav="${target}"]`); await page.waitForTimeout(400);
    check(LOG.fav.includes('POST ' + target) && await page.evaluate(id => document.querySelector(`.mk-fav[data-fav="${id}"]`).getAttribute('aria-pressed') === 'true', target), 'tapping an empty heart saves it (POST) and fills it');
    await page.click(`.mk-fav[data-fav="${target}"]`); await page.waitForTimeout(400);
    check(LOG.fav.includes('DELETE ' + target) && await page.evaluate(id => document.querySelector(`.mk-fav[data-fav="${id}"]`).getAttribute('aria-pressed') === 'false', target), 'tapping a filled heart removes it (DELETE)');
    check(await page.evaluate(() => { const f = document.querySelector('.mk-fav'), r = f.getBoundingClientRect(), top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return top === f || f.contains(top); }), 'the heart sits above the card link (tapping it does not open the product)');
    check(!errors.length, 'no page errors from hearts' + (errors.length ? ': ' + errors[0] : ''));
    await ctx.close();
  }
  {
    const { ctx, page } = await openPage(browser, port, 375);
    await page.waitForSelector('#trendingProducts .mk-product');
    await page.click('.mk-fav'); await page.waitForURL(/login/, { timeout: 8000 }).catch(() => {});
    check(/login/.test(page.url()), 'signed out, tapping a heart sends the shopper to log in');
    await ctx.close();
  }

  // ---- search dropdown: keyboard ----
  {
    const { ctx, page } = await openPage(browser, port, 1280);
    await page.waitForSelector('#trendingProducts .mk-product');
    await page.click('#marketplaceSearch'); await page.keyboard.type('store'); await page.waitForSelector('#searchPreviewDropdown .search-preview-item', { timeout: 5000 });
    await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown');
    const k = await page.evaluate(() => { const items = [...document.querySelectorAll('#searchPreviewDropdown [role="option"]')]; const input = document.getElementById('marketplaceSearch'); return { n: items.length, active: items.filter(i => i.classList.contains('is-active')).length, ok: input.getAttribute('aria-activedescendant') === items[1].id && items[1].getAttribute('aria-selected') === 'true', expanded: input.getAttribute('aria-expanded') }; });
    check(k.n > 2 && k.active === 1 && k.ok && k.expanded === 'true', 'search dropdown: arrow keys move one highlighted suggestion (aria-activedescendant, aria-selected)');
    await page.keyboard.press('ArrowUp'); await page.keyboard.press('ArrowUp'); // 2nd item -> 1st -> wraps to the last
    check(await page.evaluate(() => { const items = [...document.querySelectorAll('#searchPreviewDropdown [role="option"]')]; return document.getElementById('marketplaceSearch').getAttribute('aria-activedescendant') === items[items.length - 1].id; }), 'arrow up from the first suggestion wraps to the last one');
    await page.keyboard.press('Escape');
    check(await page.evaluate(() => document.getElementById('marketplaceSearch').getAttribute('aria-expanded') === 'false' && !document.getElementById('marketplaceSearchBar').classList.contains('open')), 'Escape closes the suggestions');
    await ctx.close();
  }

  // ---- a failed stores request: its own message + retry, products still load ----
  {
    MODE.failStores = true;
    const { ctx, page } = await openPage(browser, port, 375);
    await page.waitForSelector('#trendingProducts .mk-product');
    check(await page.evaluate(() => /Couldn.t load stores/.test(document.getElementById('storesGrid').textContent) && !!document.querySelector('#storesGrid [data-mk-action="retry"]')), 'stores failing shows "Couldn\u2019t load stores" + Try again (not "coming soon")');
    MODE.failStores = false;
    await page.click('#storesGrid [data-mk-action="retry"]'); await page.waitForSelector('#storesGrid .mk-store', { timeout: 5000 });
    check(true, 'Try again reloads the stores');
    await ctx.close();
  }

  // ---- opens already filtered from a shared link ----
  {
    const { ctx, page } = await openPage(browser, port, 1440, '/marketplace.html?category=clothing&search=shirt');
    await page.waitForSelector('#storesGrid .mk-store');
    check(await page.evaluate(() => document.getElementById('marketplaceSearch').value === 'shirt' && /clothing/i.test(document.getElementById('storesTitle').textContent + '') && /shirt/.test(document.getElementById('storesTitle').textContent) && document.querySelector('.cat-tile.is-active')?.dataset.category === 'clothing' && /\d/.test(document.getElementById('heroStoreCount').textContent)), '?category= and ?search= restore the filtered view (hero numbers still load)');
    await ctx.close();
  }

  await browser.close(); server.close();
  console.log(`\n${bad} problem(s)`);
  process.exitCode = bad ? 1 : 0;
})();
