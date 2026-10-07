#!/usr/bin/env node
'use strict';
/*
 * Runs the REAL routes/seo.js handlers for a product's address
 * (GET /:storeSlug/:productSlug and GET /p/:productId), the REAL src/seo.js and
 * src/slugs.js, and the REAL product-detail.html as the page shell, with Express,
 * Prisma, the cache and config stubbed (no database, no network, no browser):
 *
 *   npm run test:product-share
 *
 * Proves: the product's own address (/<store>/<name>-<key>) answers with the real
 * product page whose <head> carries THAT product's title (with the price),
 * description, canonical/og:url, preview image (the ~480px THUMBNAIL, falling back
 * full photo -> store logo -> brand card) and schema.org JSON-LD; the page's own
 * CSS / JS / images are root-relative (it lives one folder deeper than the other
 * pages); the page learns its product from two <meta> tags; the lookup is scoped
 * to the store and keyed on the tail of the id; every other spelling of the
 * address (old name, capitals, trailing slash, the store's id) 301s to the one
 * real address and keeps the query string; /p/<id> 301s to it; seller-written text
 * cannot break out of a tag or a script; a draft / lapsed / deleted-store / unknown
 * product gets generic brand tags and leaks nothing; reserved words and malformed
 * addresses never reach the database; pages are cached and a live page never
 * outlives its store's time; the routes are registered before the /:slug catch-all.
 * Does NOT prove: what WhatsApp itself renders (it caches previews, and only a
 * real share can show that), real Express routing, or Postgres.
 */
const fs = require('fs');
const path = require('path');
const Module = require('module');
const SRC = path.resolve(__dirname, '..', 'src');
const SHELL = fs.readFileSync(path.resolve(__dirname, '..', '..', 'product-detail.html'), 'utf8');
const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail });

const DAY = 86400000;
const now = Date.now();
const future = new Date(now + 40 * DAY);
const past = new Date(now - 2 * DAY);

// ---- stubs -------------------------------------------------------------------
class Dec { constructor(v) { this.v = v; } toString() { return String(this.v); } } // like Prisma.Decimal: only toString
const ID = 'cmg8x2k1a0003abcd5efgh6ij';   // a real-looking cuid; its key (last 8 characters) is 5efgh6ij
const KEY = '5efgh6ij';
const mkStore = (o = {}) => ({ id: 'cstore1', slug: 'asia-ivan', name: 'Asia Ivan Store', logo: 'https://cdn.example.com/logo.png', district: 'kampala', seo: {}, isPublished: true, deletedAt: null, trialEndsAt: null, subscriptionPaidUntil: future, ...o });
const mkProduct = (o = {}) => ({
  id: ID, name: 'Blue Sofa', description: 'Three-seater, very comfy.', price: new Dec('450000.00'), stock: 3,
  image: 'https://cdn.example.com/f/1.jpg',
  images: ['https://cdn.example.com/f/1.jpg', 'https://cdn.example.com/f/2.jpg'],
  thumbnails: ['https://cdn.example.com/t/1.jpg', 'https://cdn.example.com/t/2.jpg'],
  store: mkStore(), ...o
});

let row = mkProduct();
let dbCalls = 0;
let lastWhere = null;
const fakePrisma = { product: { findFirst: async (args) => { dbCalls++; lastWhere = args && args.where; return row; } }, store: { findFirst: async () => null, findMany: async () => [] }, paymentMethod: { findMany: async () => [] } };
const cacheMap = new Map(); const cacheTtl = new Map();
const fakeCache = { get: async (k) => (cacheMap.has(k) ? cacheMap.get(k) : null), set: async (k, v, ttl) => { cacheMap.set(k, v); cacheTtl.set(k, ttl); } };
let shellHtml = SHELL;
const routeOrder = [];
const routeTable = {};
const fakeExpress = { Router: () => { const r = {}; for (const v of ['get', 'post', 'put', 'patch', 'delete']) r[v] = (p, ...h) => { const key = `${v.toUpperCase()} ${p}`; routeOrder.push(key); routeTable[key] = h[h.length - 1]; }; return r; } };
const origLoad = Module._load;
Module._load = function (request, parent) {
  const from = parent && parent.filename ? parent.filename : '';
  if (request === 'express') return fakeExpress;
  if (request === '@prisma/client') return { Prisma: { Decimal: Dec }, PrismaClient: class {} };
  if (request === 'jsonwebtoken') return { verify() { throw new Error('x'); }, sign() { return 't'; } };
  if (from.startsWith(SRC)) {
    if (/(^|\/)prisma$/.test(request)) return fakePrisma;
    if (/(^|\/)cache$/.test(request)) return fakeCache;
    if (/(^|\/)config$/.test(request)) return { isProd: false, jwtSecret: 'x', frontendUrl: 'http://frontend.example', frontendDir: '/nonexistent', siteUrl: 'https://fallback.example', r2: {} };
    if (/(^|\/)storeShell$/.test(request)) return { loadStoreShell: async () => null, loadProductShell: async () => shellHtml };
    if (/(^|\/)push$/.test(request)) return { sendPushToUser: async () => {} };
    if (/(^|\/)orderCode$/.test(request)) return { generateOrderCode: () => 'ORD1' };
    if (/(^|\/)validation$/.test(request)) return new Proxy({ validateBody: () => (q, r, n) => n() }, { get: (t, k) => (k in t ? t[k] : {}) });
    if (/(^|\/)middleware$/.test(request) && /routes/.test(from)) return { requireAuth: (q, r, n) => n(), requireSeller: (q, r, n) => n(), optionalAuth: (q, r, n) => n() };
  }
  return origLoad.apply(this, arguments);
};
let loadError = null;
try { require(path.join(SRC, 'routes', 'seo.js')); } catch (e) { loadError = e; }
Module._load = origLoad;
const seo = require(path.join(SRC, 'seo.js'));
const slugs = require(path.join(SRC, 'slugs.js'));

if (loadError) { console.log(`SKIPPED: routes/seo.js could not be loaded with stubs (${loadError.message.split('\n')[0]})`); process.exit(0); }
const pageHandler = routeTable['GET /:storeSlug/:productSlug'];
const idHandler = routeTable['GET /p/:productId'];

const mkRes = () => ({ code: 200, headers: {}, body: '', location: null, status(c) { this.code = c; return this; }, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, removeHeader(k) { delete this.headers[k.toLowerCase()]; }, send(b) { this.body = b; return this; }, redirect(a, b) { if (b === undefined) { this.code = 302; this.location = a; } else { this.code = a; this.location = b; } return this; } });
const run = async (handler, req) => {
  const res = mkRes(); let err = null; let nextCalled = false;
  await handler(req, res, e => { nextCalled = true; err = e || null; });
  return { res, err, nextCalled };
};
// A request for /<storePart>/<productPart>
const callPage = (storePart, productPart, { headers = {}, query = '' } = {}) => run(pageHandler, {
  params: { storeSlug: storePart, productSlug: productPart }, path: `/${storePart}/${productPart}`, originalUrl: `/${storePart}/${productPart}${query}`,
  protocol: 'http', get: (h) => headers[h.toLowerCase()]
});
// A request for a product's real address
const addr = (r = row) => slugs.productPath(r, r.store.slug);
const callReal = (opts) => { const [, s, p] = addr().split('/'); return callPage(s, p, opts); };
const callId = (id, { headers = {}, query = '' } = {}) => run(idHandler, { params: { productId: id }, path: `/p/${id}`, originalUrl: `/p/${id}${query}`, protocol: 'http', get: (h) => headers[h.toLowerCase()] });

const meta = (html, prop) => { const m = new RegExp(`<meta (?:property|name)="${prop}" content="([^"]*)"`).exec(html); return m ? m[1] : null; };
const ldJson = (html) => { const m = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html); return m ? JSON.parse(m[1]) : null; };
const HOST = { host: 'nextastores.com', 'x-forwarded-proto': 'https' };
const brandCard = 'https://nextastores.com/assets/brand/png/social/og-link-preview-1200x630.png';
const REAL = `/asia-ivan/blue-sofa-${KEY}`;

(async () => {
  // 0. wiring
  check('both routes are registered', typeof pageHandler === 'function' && typeof idHandler === 'function');
  check('both are registered BEFORE the /:slug catch-all (which must stay last)', ['GET /p/:productId', 'GET /:storeSlug/:productSlug'].every(k => routeOrder.indexOf(k) !== -1 && routeOrder.indexOf(k) < routeOrder.indexOf('GET /:slug')) && routeOrder[routeOrder.length - 1] === 'GET /:slug');
  check('the real spelling of the test product is the address the docs describe (/asia-ivan/blue-sofa-<last 8 of the id>)', addr() === REAL);

  // 1. live product at its own address
  let { res, err } = await callReal({ headers: HOST });
  const live = res;
  check('live product: 200 and no error', res.code === 200 && !err);
  check('title is "<n> – UGX <price>" (thousands separators, Decimal price handled)', meta(res.body, 'og:title') === 'Blue Sofa \u2013 UGX 450,000' && /<title>Blue Sofa \u2013 UGX 450,000<\/title>/.test(res.body));
  check('description names the store and district', /^Sold by Asia Ivan Store in Kampala on NextaStore\. Three-seater/.test(meta(res.body, 'og:description') || ''));
  check('og:url and canonical are the product\'s own address on the visitor\'s host', meta(res.body, 'og:url') === `https://nextastores.com${REAL}` && res.body.includes(`<link rel="canonical" href="https://nextastores.com${REAL}">`));
  check('preview image is the cover THUMBNAIL, not the full photo', meta(res.body, 'og:image') === 'https://cdn.example.com/t/1.jpg' && meta(res.body, 'twitter:image') === 'https://cdn.example.com/t/1.jpg');
  check('image alt text, price tags and a square twitter:card are present', meta(res.body, 'og:image:alt') === 'Blue Sofa' && meta(res.body, 'product:price:amount') === '450000' && meta(res.body, 'product:price:currency') === 'UGX' && meta(res.body, 'twitter:card') === 'summary');
  check('indexable by default (the store has not opted out)', meta(res.body, 'robots') === 'index,follow,max-image-preview:large');
  let ld = ldJson(res.body);
  check('schema.org Product JSON-LD: name, canonical url, image, and an Offer in UGX with stock state', ld && ld['@type'] === 'Product' && ld.name === 'Blue Sofa' && ld.url === `https://nextastores.com${REAL}` && ld.image[0] === 'https://cdn.example.com/t/1.jpg' && ld.offers.price === 450000 && ld.offers.priceCurrency === 'UGX' && ld.offers.availability === 'https://schema.org/InStock');
  check('the page is told which product it is (full id + store slug in <meta>), since the address only has a short key', meta(res.body, 'nx-product-id') === ID && meta(res.body, 'nx-store-slug') === 'asia-ivan');
  check('it is the REAL product page (its own body and scripts), not a redirect page', /<body/.test(res.body) && /id="productDetail|product-detail-main|js\/product-detail\.js/.test(res.body) && !/http-equiv="refresh"/i.test(res.body) && !/location\.replace\(\s*"/.test(res.body));
  const relativeLeft = res.body.match(/\s(?:src|href)=["'](?!\/|#|\?|[a-z][a-z0-9+.-]*:)[^"']+/gi) || [];
  check('every CSS / script / image the page loads is root-relative (it lives one folder deeper than the other pages)', relativeLeft.length === 0 && res.body.includes('href="/css/main.css"') && res.body.includes('src="/js/product-detail.js"') && res.body.includes('src="/js/api.js"'), relativeLeft.join(' | '));
  check('anchors and absolute addresses are left alone (#, https:, /path)', res.body.includes('href="#"') && res.body.includes('href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/') && res.body.includes('href="/marketplace"'));
  check('served as HTML with the storefront-style headers (no API CSP, cacheable for a minute)', /text\/html/.test(res.headers['content-type'] || '') && !('content-security-policy' in res.headers) && /max-age=60/.test(res.headers['cache-control'] || '') && res.headers['x-content-type-options'] === 'nosniff');
  check('no second description / canonical / og:title: the generic tags the shell came with are replaced, not duplicated', (res.body.match(/<title>/g) || []).length === 1 && (res.body.match(/property="og:title"/g) || []).length === 1 && (res.body.match(/rel="canonical"/g) || []).length === 1 && (res.body.match(/name="description"/g) || []).length === 1 && (res.body.match(/property="og:image"/g) || []).length === 1);

  // 2. how the product is found
  const w = lastWhere;
  check('lookup: a live, undeleted product whose id ends with the key (case-insensitive), inside the named store', w && w.deletedAt === null && w.id && w.id.endsWith === KEY && w.id.mode === 'insensitive' && w.store && w.store.deletedAt === null);
  check('lookup: the store is matched by slug OR by id (a link built from a store id still works)', w && Array.isArray(w.store.OR) && w.store.OR.some(o => o.slug === 'asia-ivan') && w.store.OR.some(o => o.id === 'asia-ivan'));

  // 3. one address per product
  cacheMap.clear();
  let r = await callPage('asia-ivan', `old-name-of-the-sofa-${KEY}`, { headers: HOST, query: '?x=2' });
  check('an old / hand-edited name: 301 to the real address, query string kept', r.res.code === 301 && r.res.location === `${REAL}?x=2`);
  r = await callPage('Asia-Ivan', `Blue-Sofa-${KEY.toUpperCase()}`, { headers: HOST });
  check('capitals in the address: 301 to the real (lower-case) one', r.res.code === 301 && r.res.location === REAL);
  r = await callPage('cstore1', `blue-sofa-${KEY}`, { headers: HOST });
  check('the store\'s id instead of its slug: 301 to the slug address', r.res.code === 301 && r.res.location === REAL);
  {
    const res2 = mkRes(); await pageHandler({ params: { storeSlug: 'asia-ivan', productSlug: `blue-sofa-${KEY}` }, path: `${REAL}/`, originalUrl: `${REAL}/`, protocol: 'http', get: (h) => HOST[h.toLowerCase()] }, res2, () => {});
    check('a trailing slash: 301 to the address without it', res2.code === 301 && res2.location === REAL);
  }
  r = await callPage('asia-ivan', `blue-sofa-${KEY}`, { headers: HOST });
  check('the real address itself is a 200 (no redirect loop)', r.res.code === 200 && r.res.location === null);

  // 4. image fallbacks
  const imageFor = async (patch) => { cacheMap.clear(); row = mkProduct(patch); const x = await callReal({ headers: HOST }); return meta(x.res.body, 'og:image'); };
  check('image: only the COVER counts - an invalid cover thumbnail falls to the full cover, never to photo #2', await imageFor({ thumbnails: ['not a url', 'https://cdn.example.com/t/2.jpg'] }) === 'https://cdn.example.com/f/1.jpg');
  check('image: an old product with no thumbnails uses its full photo', await imageFor({ thumbnails: [] }) === 'https://cdn.example.com/f/1.jpg');
  check('image: a product with no photos uses the store logo', await imageFor({ thumbnails: [], images: [], image: null }) === 'https://cdn.example.com/logo.png');
  check('image: no photo and no logo falls back to the NextaStore brand card', await imageFor({ thumbnails: [], images: [], image: null, store: mkStore({ logo: null }) }) === brandCard);
  check('image: a relative or hostile URL is never used (brand card instead)', await imageFor({ thumbnails: ['/uploads/x.jpg'], images: ['javascript:alert(1)'], image: 'https://x.com/a b.jpg', store: mkStore({ logo: null }) }) === brandCard);

  // 5. text handling
  cacheMap.clear(); row = mkProduct({ name: '"><script>alert(1)</script> Sofa', description: '</script><img src=x onerror=alert(1)> & more', store: mkStore({ name: 'Bob\'s "Best" <b>Store</b>' }) });
  ({ res } = await callReal({ headers: HOST }));
  ld = ldJson(res.body);
  check('hostile product / store text: no raw tag or attribute breakout anywhere in the page', res.code === 200 && !/<script>alert|<img src=x|<b>Store|onerror=alert\(1\)>|<\/script><img/i.test(res.body) && (res.body.match(/application\/ld\+json/g) || []).length === 1);
  check('hostile text: still readable, escaped, in the title - and intact (not executable) inside the JSON-LD', /&lt;script&gt;alert\(1\)&lt;\/script&gt;/.test(meta(res.body, 'og:title') || '') && ld && ld.name === '"><script>alert(1)</script> Sofa' && ld.offers.seller.name === 'Bob\'s "Best" <b>Store</b>');
  cacheMap.clear(); row = mkProduct({ name: 'A very long product name that goes on and on and on and on and on and on, well past the limit', description: '' });
  ({ res } = await callReal({ headers: HOST }));
  const longTitle = meta(res.body, 'og:title') || '';
  check('a long name is shortened but the price is never cut (title <= 70 chars, ends with the price)', res.code === 200 && longTitle.length <= 70 && /\u2013 UGX 450,000$/.test(longTitle));
  check('a long name gives a readable address of sensible length that still ends with the key', addr().length < 100 && addr().endsWith(`-${KEY}`) && /^\/asia-ivan\/[a-z0-9-]+$/.test(addr()));
  cacheMap.clear(); row = mkProduct({ price: new Dec('0'), stock: 0 });
  ({ res } = await callReal({ headers: HOST }));
  check('no price -> no "UGX 0" in the title, no price meta, no Offer; out of stock is stated', meta(res.body, 'og:title') === 'Blue Sofa' && meta(res.body, 'product:price:amount') === null && !ldJson(res.body).offers && /Currently out of stock\./.test(meta(res.body, 'og:description') || ''));
  cacheMap.clear(); row = mkProduct({ stock: 0 });
  ({ res } = await callReal({ headers: HOST }));
  check('out of stock with a price: the Offer says OutOfStock', ldJson(res.body).offers.availability === 'https://schema.org/OutOfStock');
  cacheMap.clear(); row = mkProduct({ store: mkStore({ seo: { indexable: false } }) });
  ({ res } = await callReal({ headers: HOST }));
  check('a store that opted out of search engines: its products are noindex too', meta(res.body, 'robots') === 'noindex,nofollow');

  // 6. privacy: nothing product-specific unless the store is live
  const leaks = (html) => /Blue Sofa|450,000|450000|cdn\.example\.com|Asia Ivan Store|Three-seater/.test(html);
  check('control: the leak detector does not fire on the untouched shell, so it can fail', !leaks(SHELL) && leaks(live.body));
  cacheMap.clear(); row = mkProduct({ store: mkStore({ isPublished: false }) });
  ({ res } = await callReal({ headers: HOST }));
  check('draft store: 200, generic brand tags, nothing about the product leaks, never cached', res.code === 200 && !leaks(res.body) && meta(res.body, 'og:image') === brandCard && meta(res.body, 'og:title') === 'Product | NextaStore' && meta(res.body, 'robots') === 'noindex,nofollow' && res.headers['cache-control'] === 'no-store' && cacheMap.size === 0);
  check('draft store: the page still learns its product (the owner gets through - the page asks the API)', meta(res.body, 'nx-product-id') === ID && meta(res.body, 'nx-store-slug') === 'asia-ivan' && !/rel="canonical"/.test(res.body));
  cacheMap.clear(); row = mkProduct({ store: mkStore({ subscriptionPaidUntil: past, trialEndsAt: past }) });
  ({ res } = await callReal({ headers: HOST }));
  check('lapsed store (trial and paid time over): generic tags, nothing leaks', res.code === 200 && !leaks(res.body) && meta(res.body, 'og:image') === brandCard);
  cacheMap.clear(); row = mkProduct({ store: mkStore({ deletedAt: new Date() }) });
  ({ res } = await callReal({ headers: HOST }));
  check('deleted store: real 404, generic tags, nothing leaks, no product id handed out', res.code === 404 && !leaks(res.body) && meta(res.body, 'nx-product-id') === null);
  cacheMap.clear(); row = null;
  ({ res } = await callPage('asia-ivan', `blue-sofa-${KEY}`, { headers: HOST }));
  check('unknown / deleted product: real 404, the page with generic tags (it shows its own not-found state), never cached', res.code === 404 && /<body/.test(res.body) && meta(res.body, 'og:image') === brandCard && meta(res.body, 'nx-product-id') === null && res.headers['cache-control'] === 'no-store' && /Product not found/.test(res.body));

  // 7. the page cannot be read -> the site's own copy still works
  row = mkProduct(); cacheMap.clear(); shellHtml = null;
  ({ res } = await callReal({ headers: HOST }));
  check('page file unreadable: sent to the frontend host\'s own copy of the page', res.code === 302 && res.location === `http://frontend.example/product-detail.html?id=${ID}&store=asia-ivan`);
  row = null;
  const noShell = await callPage('asia-ivan', `blue-sofa-${KEY}`, { headers: HOST });
  check('page file unreadable and unknown product: steps aside (next) instead of crashing', noShell.nextCalled && !noShell.err);
  shellHtml = SHELL;

  // 8. addresses that are not products never reach the database
  dbCalls = 0; cacheMap.clear(); row = mkProduct();
  const notProducts = [['css', 'main-abc12345'], ['api', 'orders-abc12345'], ['errors', '404'], ['uploads', 'x-abc12345'], ['p', 'blue-sofa-abc12345'], ['asia-ivan', 'nokeyhere'.replace(/./g, '-')], ['asia-ivan', 'blue-sofa-ab'], ['a.b', 'c-abc12345'], ['asia-ivan', 'x.y-abc12345'], ['asia-ivan', 'a%2Fb-abc12345'], ['assets', 'brand-abc12345']];
  const notResults = [];
  for (const [s, p] of notProducts) notResults.push(await callPage(s, p, { headers: HOST }));
  check('reserved first words (css, api, errors, uploads, assets, p), malformed parts and a too-short key step aside - and the database is never queried', notResults.every(x => x.nextCalled && x.res.body === '') && dbCalls === 0);

  // 9. /p/<id>: a product by its id alone
  row = mkProduct(); cacheMap.clear(); dbCalls = 0;
  ({ res } = await callId(ID, { headers: HOST }));
  check('/p/<id>: permanent redirect to the product\'s own address', res.code === 301 && res.location === REAL);
  ({ res } = await callId(ID, { headers: HOST, query: '?x=2' }));
  check('/p/<id>: a throwaway ?x=2 (how a preview is re-tested) survives the redirect', res.code === 301 && res.location === `${REAL}?x=2`);
  row = mkProduct({ store: mkStore({ isPublished: false }) });
  ({ res } = await callId(ID, { headers: HOST }));
  check('/p/<id> of a draft store: same redirect - the real address is where the privacy rule lives, nothing is revealed here', res.code === 301 && res.location === REAL && !leaks(res.body));
  row = mkProduct({ id: 'p1' });
  ({ res } = await callId('p1', { headers: HOST }));
  check('an id too short to key on cannot have a clean address: sent to the static product page', res.code === 302 && res.location === '/product-detail?id=p1&store=asia-ivan');
  row = null;
  ({ res } = await callId('cunknown9', { headers: HOST }));
  check('/p/<unknown id>: real 404, the page with generic tags (its own not-found state)', res.code === 404 && /<body/.test(res.body) && meta(res.body, 'og:image') === brandCard && meta(res.body, 'nx-product-id') === null);
  dbCalls = 0; row = mkProduct();
  const bad = ['a.b', 'x'.repeat(65), 'has space', '../etc', 'a%2Fb', ''];
  const badResults = [];
  for (const id of bad) badResults.push((await callId(id, { headers: HOST })).res);
  check('malformed ids: 404, and the database is never queried', badResults.every(x => x.code === 404 && x.location === null) && dbCalls === 0);

  // 10. caching
  cacheMap.clear(); cacheTtl.clear(); row = mkProduct(); dbCalls = 0;
  await callReal({ headers: HOST }); await callReal({ headers: HOST });
  check('a live page is cached: the second request does not query the database', dbCalls === 1);
  const before = dbCalls;
  r = await callPage('asia-ivan', `a-different-name-${KEY}`, { headers: HOST });
  check('a cached page still redirects a wrong spelling to the real address (from the cache, not the database)', r.res.code === 301 && r.res.location === REAL && dbCalls === before);
  check('the cache key is per host (a preview built for one host is not served on another)', [...cacheMap.keys()].every(k => k.includes('https://nextastores.com')));
  cacheMap.clear(); cacheTtl.clear(); row = mkProduct({ store: mkStore({ trialEndsAt: null, subscriptionPaidUntil: new Date(Date.now() + 20 * 1000) }) });
  await callReal({ headers: HOST });
  const ttl = [...cacheTtl.values()][0];
  check('a live page never outlives its store\'s time (20s left -> cached for <= 20s, not 60s)', ttl >= 1 && ttl <= 20);
  cacheMap.clear(); row = mkProduct();
  const viaLocal = (await callReal({ headers: { host: 'localhost:5000' } })).res;
  check('on another host the URLs follow that host (no hard-coded production domain)', meta(viaLocal.body, 'og:url') === `http://localhost:5000${REAL}` && meta(viaLocal.body, 'og:image') === 'https://cdn.example.com/t/1.jpg');

  // 11. pure helpers
  check('formatUgx: whole shillings, separators, and empty for 0 / junk', seo.formatUgx(1234567.4) === 'UGX 1,234,567' && seo.formatUgx(999) === 'UGX 999' && seo.formatUgx(0) === '' && seo.formatUgx('abc') === '' && seo.formatUgx(null) === '');
  check('productShareUrl: the store address + name + key, trailing slash on the site URL dropped; /p/<id> when there is no store slug', seo.productShareUrl('https://nextastores.com/', { id: ID, name: 'Blue Sofa' }, 'asia-ivan') === `https://nextastores.com${REAL}` && seo.productShareUrl('https://nextastores.com', { id: ID, name: 'Blue Sofa' }, '') === `https://nextastores.com/p/${ID}`);
  check('appProductUrl (the store page\'s JSON-LD product links) uses the same address', seo.appProductUrl('https://nextastores.com', { id: ID, name: 'Blue Sofa' }, 'asia-ivan') === `https://nextastores.com${REAL}`);
  check('rootRelative: rewrites file paths; leaves /abs, #anchor, ?query, https:, data:, mailto:, javascript: and data-src alone',
    seo.rootRelative('<link href="css/a.css"><script src=\'js/a.js\'></script><img src="assets/x.png"><a href="/m"></a><a href="#t"></a><a href="?q=1"></a><a href="https://e.x/a"></a><img src="data:image/png;base64,AA"><a href="mailto:a@b.c"></a><a href="javascript:void(0)"></a><div data-src="keep/me"></div>')
      === '<link href="/css/a.css"><script src=\'/js/a.js\'></script><img src="/assets/x.png"><a href="/m"></a><a href="#t"></a><a href="?q=1"></a><a href="https://e.x/a"></a><img src="data:image/png;base64,AA"><a href="mailto:a@b.c"></a><a href="javascript:void(0)"></a><div data-src="keep/me"></div>');

  let failed = 0;
  for (const c of results) { console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok || !c.detail ? '' : ` \u2014 ${c.detail}`}`); if (!c.ok) failed++; }
  console.log(`\n${results.length - failed}/${results.length} product-share checks passed.`);
  process.exitCode = failed ? 1 : 0;
})().catch(e => { console.error(e); process.exit(2); });
