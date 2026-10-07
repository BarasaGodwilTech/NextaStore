#!/usr/bin/env node
'use strict';
/*
 * Drives the REAL js/main.js, js/store-detail.js and js/map-preview.js against the
 * REAL store-detail.html in jsdom, with the API stubbed:
 *
 *   npm i --no-save jsdom && npm run test:store-front
 *
 * Proves: tier ribbon / medal / trust card / product marks render for a badged
 * store and nothing extra for an unbadged one; hostile tier/name/colour/logo
 * values are shown as text and never become markup or CSS; the owner of a lapsed
 * store gets the shutter + renew strip and cannot add to a cart; a shopper gets
 * the closed-shop page (identity only, no payment wording, noindex); the map
 * preview sends a referrer policy, shows a clean fallback when a tile is refused,
 * and never links a non-Google URL. Does NOT prove: real layout/pixels or the
 * real OpenStreetMap servers (the sandbox had no access to them).
 */
let JSDOM; try { ({ JSDOM } = require('jsdom')); } catch (_) { console.log('SKIPPED: jsdom is not installed (npm i --no-save jsdom).'); process.exit(0); }
const fs = require('fs');
const ROOT = require('path').resolve(__dirname, '..', '..');
const out = []; const check = (n, ok, d='') => out.push({n, ok: !!ok, d});

function makeDom(url) {
  let html = fs.readFileSync(ROOT + '/store-detail.html', 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  w.matchMedia = w.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  w.IntersectionObserver = class { observe() {} disconnect() {} unobserve() {} };
  w.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} };
  w.scrollTo = () => {};
  w.fetch = async () => { throw new Error('no network in test'); };
  w.eval(fs.readFileSync(ROOT + '/js/main.js', 'utf8') + '\n;window.app = app;');
  return dom;
}

async function scenario(name, apiImpl, opts = {}) {
  const dom = makeDom('http://localhost:3000/asia-ivan-store');
  const w = dom.window;
  const app = w.app;
  if (!app) throw new Error('app not defined by main.js');
  app.apiRequest = async (ep) => apiImpl(ep);
  app.showAlert = (m, t) => { w.__alerts = (w.__alerts || []).concat([[m, t]]); };
  w.NextaCart = { count: () => 0, add() { w.__added = true; } };
  w.NextaStoreBanner = { applyStoreBanner() {} };
  w.eval(fs.readFileSync(ROOT + '/js/map-preview.js', 'utf8'));
  w.eval(fs.readFileSync(ROOT + '/js/store-detail.js', 'utf8') + '\n;window.__mgr = storeDetailManager;');
  await new Promise(r => setTimeout(r, 200));
  return { dom, w, doc: w.document, mgr: w.__mgr, app };
}

const baseStore = { id: 's1', name: 'Asia Ivan Store', slug: 'asia-ivan-store', description: 'd', district: 'mbale', productCount: 1, followers: 0, badges: [], bannerColor: '#00B074', logo: null };
const goldTier = { key: 'gold-partner', tone: 'gold', label: 'Gold Partner', shortLabel: 'Gold', icon: 'fa-crown', rank: 2 };
const prods = { data: [{ id: 'p1', name: 'Wooden Chair', price: 25000, originalPrice: 30000, stock: 5, images: [], icon: 'fa-box' }], pagination: { page: 1, pages: 1, total: 1 } };
const api = (store) => (ep) => {
  if (ep.startsWith('/store/public')) return { data: store };
  if (ep.startsWith('/products')) return prods;
  if (ep.includes('favorites')) return { data: { favorited: [] } };
  if (ep.includes('presence')) return { data: {} };
  return { data: {} };
};

(async () => {
  // 1. Gold store: ribbon, medal, trust card, product mark
  let s = await scenario('gold', api({ ...baseStore, tier: goldTier, badges: [{ ...goldTier, reason: '12+ months on NextaStore' }] }));
  let hero = s.doc.getElementById('storeHero');
  check('gold: hero carries data-tier="gold"', hero.dataset.tier === 'gold');
  check('gold: banner ribbon shows the tier label', s.doc.querySelector('.tier-ribbon--gold')?.textContent.includes('Gold Partner'));
  check('gold: logo medal is present', !!s.doc.querySelector('.tier-medal--gold'));
  check('gold: sidebar trust card explains the badge in the agreed wording', (s.doc.getElementById('storeTrustCard')?.querySelector('p')?.textContent || '') === '12+ months on NextaStore. Confirmed by us, not self-declared.');
  check('gold: product card has a tier mark and data-tier', !!s.doc.querySelector('.product-card[data-tier="gold"] .tier-mark--gold'));
  check('gold: no shutter / no owner strip for a shopper', !s.doc.getElementById('storePreviewStrip') && !s.doc.querySelector('.banner-shutter'));

  // 2. Unbadged store renders exactly as before
  s = await scenario('plain', api({ ...baseStore }));
  check('plain: no tier decoration anywhere', !s.doc.getElementById('storeHero').dataset.tier && !s.doc.querySelector('.tier-ribbon, .tier-medal, .tier-mark, #storeTrustCard'));
  check('plain: Add to Cart label is full text', s.doc.querySelector('.product-card .add-to-cart span')?.textContent === 'Add to Cart');

  // 3. Hostile tier data cannot inject markup / classes
  s = await scenario('hostile', api({ ...baseStore, tier: { tone: 'gold" onmouseover="x', label: '<img src=x onerror=alert(1)>', icon: 'fa-x" onclick="y' } }));
  check('hostile tier: ignored (tone is whitelisted)', !s.doc.querySelector('.tier-ribbon') && !s.doc.querySelector('[onmouseover],[onclick]'));
  s = await scenario('hostile2', api({ ...baseStore, tier: { ...goldTier, label: '<img src=x onerror=alert(1)>', icon: 'fa-crown" onclick="y' }, badges: [{ ...goldTier, reason: '<b>x</b>' }] }));
  check('hostile label/icon/reason: rendered as text, no elements or handlers', !s.doc.querySelector('.tier-ribbon img, #storeTrustCard b, [onclick]') && s.doc.querySelector('.tier-ribbon')?.textContent.includes('<img'));

  // 4. Owner of a lapsed store
  s = await scenario('lapsed-owner', api({ ...baseStore, preview: { state: 'lapsed', endedAt: new Date().toISOString(), hadPaidPlan: false } }));
  check('lapsed owner: status strip with a Renew link to subscription.html', s.doc.querySelector('#storePreviewStrip.preview-strip--lapsed a')?.getAttribute('href') === 'subscription.html');
  check('lapsed owner: says it is the free TRIAL that ended', /free trial has ended/i.test(s.doc.getElementById('storePreviewStrip')?.textContent || ''));
  check('lapsed owner: shutter drawn over the banner and body flagged', !!s.doc.querySelector('#storeBanner .banner-shutter') && s.doc.body.classList.contains('store-lapsed'));
  check('lapsed owner: sees the real store, NOT the shoppers\' closed screen', !s.doc.getElementById('closedShopScreen') && !s.doc.body.classList.contains('store-closed-public'));
  s.mgr.addToCart('p1'); 
  check('lapsed owner: Add to cart is refused client-side too', !s.w.__added && (s.w.__alerts || []).some(a => /closed to shoppers/.test(a[0])));
  s = await scenario('ending-owner', api({ ...baseStore, preview: { state: 'ending', daysLeft: 2, onTrial: false } }));
  check('ending owner: countdown strip, no shutter', /2 days left in your paid month/.test(s.doc.getElementById('storePreviewStrip')?.textContent || '') && !s.doc.querySelector('.banner-shutter'));

  // 5. Visitor on a lapsed store -> closed shop page (identity only)
  const closed = (extra = {}) => (ep) => { if (ep.startsWith('/store/public')) { const e = new Error('This store is not currently available.'); e.code = 'STORE_INACTIVE'; e.status = 404; e.store = { name: 'Asia Ivan Store', slug: 'asia-ivan-store', logo: '/uploads/l.png', bannerColor: '#00B074', ...extra }; throw e; } return { data: {} }; };
  s = await scenario('closed', closed());
  check('closed: the shop sign shows the store name', s.doc.getElementById('closedShopName')?.textContent === 'Asia Ivan Store');
  check('closed: shutter + "Closed for now" door sign', !!s.doc.querySelector('.closed-shop-shutter') && /Closed for now/.test(s.doc.querySelector('.closed-shop-door-sign')?.textContent || ''));
  check('closed: says nothing about payment / trial / subscription', !/trial|paid|payment|subscription|expired|renew/i.test(s.doc.getElementById('closedShopScreen')?.textContent || ''));
  check('closed: page is marked noindex', s.doc.querySelector('meta[name=robots]')?.content === 'noindex, nofollow');
  check('closed: no product grid content leaks', !s.doc.querySelector('#productsGrid .product-card'));
  check('closed: the shopfront is a full-screen layer on <body>, not inside the product panel', s.doc.getElementById('closedShopScreen')?.parentElement === s.doc.body && s.doc.body.classList.contains('store-closed-public') && !s.doc.querySelector('#productsGrid #closedShopScreen'));
  check('closed: a way out to the marketplace', [...s.doc.querySelectorAll('#closedShopScreen a')].some(a => a.getAttribute('href') === 'marketplace.html' && /Browse Other Stores/.test(a.textContent)));
  s = await scenario('closed-hostile', closed({ name: '<img src=x onerror=alert(1)>', bannerColor: 'red;} body{display:none', logo: 'x") ; background:url(//evil' }));
  check('closed hostile: name as text only', !s.doc.querySelector('#closedShopScreen img') && s.doc.getElementById('closedShopName')?.textContent.includes('<img'));
  check('closed hostile: non-hex colour replaced by the default', /#0B3B2B/i.test(s.doc.getElementById('closedShopScreen')?.getAttribute('style') || '') && !/display/.test(s.doc.getElementById('closedShopScreen')?.getAttribute('style') || ''));
  s = await scenario('closed-noid', (ep) => { if (ep.startsWith('/store/public')) { const e = new Error('x'); e.code = 'STORE_INACTIVE'; throw e; } return { data: {} }; });
  check('closed without identity: falls back to the generic unavailable page', /Isn.t Available Right Now/.test(s.doc.getElementById('storeName').textContent) && !s.doc.getElementById('closedShopScreen'));

  // 6. Map preview
  const dom = makeDom('http://localhost:3000/asia-ivan-store'); const w = dom.window;
  w.eval(fs.readFileSync(ROOT + '/js/map-preview.js', 'utf8'));
  const png = new Uint8Array([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,1,2,3,4]);
  const mk = () => { const el = w.document.createElement('div'); w.document.body.appendChild(el); el.getBoundingClientRect = () => ({ width: 230 }); return el; };
  let seen = [];
  w.URL.createObjectURL = () => 'blob:ok'; w.URL.revokeObjectURL = () => {};
  w.fetch = async (url, init) => { seen.push({ url, init }); return { ok: true, headers: { get: () => 'image/png' }, blob: async () => new w.Blob([png]) }; };
  let el = mk(); w.NextaStoreMapPreview.render(el, { lat: 0.35, lng: 32.58, mapsUrl: 'https://www.google.com/maps/search/?api=1&query=0.35,32.58' });
  check('map: loading skeleton shows first', !!el.querySelector('.map-preview-loading'));
  await new Promise(r => setTimeout(r, 30));
  check('map: tiles requested WITH a referrer policy (what OSM needs)', seen.length > 0 && seen.every(x => x.init.referrerPolicy === 'strict-origin-when-cross-origin' && x.init.credentials === 'omit'));
  check('map: tiles drawn, pin present, attribution link present', el.querySelectorAll('.map-preview-tile').length === seen.length && !!el.querySelector('.map-preview-marker') && !!el.querySelector('.map-preview-attribution a'));
  check('map: frame sized to its own slot (230px), not a padded parent', el.querySelector('.map-preview-frame').style.width === '230px');
  seen = []; w.fetch = async () => ({ ok: false, status: 403, headers: { get: () => 'image/png' }, blob: async () => new w.Blob([png]) });
  el = mk(); w.NextaStoreMapPreview.render(el, { lat: 0.35, lng: 32.58, mapsUrl: 'https://www.google.com/maps/search/?api=1&query=0.35,32.58' });
  await new Promise(r => setTimeout(r, 30));
  check('map: a refused (403) tile shows the clean fallback card, not an error image', !!el.querySelector('.map-preview-fallback') && !el.querySelector('.map-preview-tile'));
  check('map: fallback still links to Google Maps', !!el.querySelector('.map-preview-fallback a[href^="https://www.google.com/"]'));
  let calls = 0; w.fetch = async () => { calls++; return { ok: true }; };
  el = mk(); w.NextaStoreMapPreview.render(el, { lat: 0.35, lng: 32.58 });
  check('map: once refused, later previews skip OSM entirely (no more requests)', calls === 0 && !!el.querySelector('.map-preview-fallback'));

  const dom2 = makeDom('http://localhost:3000/x'); const w2 = dom2.window; w2.eval(fs.readFileSync(ROOT + '/js/map-preview.js', 'utf8'));
  w2.URL.createObjectURL = () => 'blob:ok'; w2.URL.revokeObjectURL = () => {};
  w2.fetch = async () => { throw new TypeError('CORS'); };
  const el2 = w2.document.createElement('div'); w2.document.body.appendChild(el2);
  w2.NextaStoreMapPreview.render(el2, { lat: 0.35, lng: 32.58, width: 300, mapsUrl: 'javascript:alert(1)' });
  await new Promise(r => setTimeout(r, 30));
  const imgs = [...el2.querySelectorAll('img.map-preview-tile')];
  check('map: on a network/CORS failure it falls back to plain <img> tiles with referrerpolicy set', imgs.length > 0 && imgs.every(i => i.getAttribute('referrerpolicy') === 'strict-origin-when-cross-origin'));
  check('map: a javascript: mapsUrl is dropped, never linked', !el2.querySelector('a.map-preview-overlay-link'));

  out.forEach(x => console.log(`${x.ok ? 'PASS' : 'FAIL'}  ${x.n}${x.ok ? '' : '  -> ' + x.d}`));
  const bad = out.filter(x => !x.ok); console.log(`\n${out.length - bad.length}/${out.length} passed`); process.exit(bad.length ? 1 : 0);
})().catch(e => { console.error('CRASH', e); process.exit(1); });
