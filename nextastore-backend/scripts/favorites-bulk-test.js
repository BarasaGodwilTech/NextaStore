#!/usr/bin/env node
'use strict';
/*
 * Runs the REAL src/routes/favorites.js handler for GET /favorites/check and
 * the REAL StoreDetail.loadFavoriteStates() from js/store-detail.js, with
 * Express, Prisma, the middleware and the browser stubbed (no node_modules,
 * database or browser needed):
 *
 *   npm run test:favorites-bulk
 *
 * Proves: one query answers a whole page; signed-out -> empty list and no
 * query; ids are de-duplicated, trimmed and capped at 60; '/check' is declared
 * before '/:productId'; the storefront makes ONE request per page, none when
 * signed out, none for products it already checked, and falls back to the old
 * per-card lookup against a backend without the route. Does NOT prove: real
 * Express routing or the query against Postgres.
 */
const fs = require('fs');
const path = require('path');
const Module = require('module');
const SRC = path.resolve(__dirname, '..', 'src');
const ROOT = path.resolve(__dirname, '..', '..');
const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail });

// ---- backend ---------------------------------------------------------------
const calls = [];
const saved = new Set(['p1', 'p3']);
const fakePrisma = { productFavorite: { findMany: async (q) => { calls.push(q); return q.where.productId.in.filter(id => saved.has(id)).map(productId => ({ productId })); } } };
const routeTable = {}; const order = [];
const fakeExpress = { Router: () => { const r = {}; for (const v of ['get', 'post', 'delete']) r[v] = (p, ...h) => { routeTable[`${v.toUpperCase()} ${p}`] = h; order.push(`${v.toUpperCase()} ${p}`); }; return r; } };
const origLoad = Module._load;
Module._load = function (request, parent) {
  const from = parent && parent.filename ? parent.filename : '';
  if (request === 'express') return fakeExpress;
  if (from.startsWith(SRC)) {
    if (/(^|\/)prisma$/.test(request)) return fakePrisma;
    if (/(^|\/)utils$/.test(request)) return { apiError: (m, s = 400) => Object.assign(new Error(m), { status: s }) };
    if (/(^|\/)helpers$/.test(request)) return { serializeProduct: x => x, storefrontVisibleWhere: () => ({}) };
    if (/(^|\/)middleware$/.test(request)) return { requireAuth: (q, r, n) => n(), optionalAuth: (q, r, n) => n() };
  }
  return origLoad.apply(this, arguments);
};
require(path.join(SRC, 'routes', 'favorites.js'));
Module._load = origLoad;

const handler = routeTable['GET /check'].slice(-1)[0];
const run = async (req) => { const res = { body: null, json(b) { this.body = b; return this; } }; let err = null; await handler(req, res, e => { err = e; }); return { res, err }; };

(async () => {
  check("'/check' is declared before '/:productId' (otherwise it is read as a product id)", order.indexOf('GET /check') !== -1 && order.indexOf('GET /check') < order.indexOf('GET /:productId'));
  let r = await run({ user: { id: 'u1' }, query: { ids: 'p1,p2,p3' } });
  check('a signed-in viewer gets exactly their saved ids back, from ONE query', !r.err && JSON.stringify(r.res.body.data.favorited) === '["p1","p3"]' && calls.length === 1 && calls[0].where.userId === 'u1');
  calls.length = 0;
  r = await run({ user: null, query: { ids: 'p1,p3' } });
  check('signed out: empty list and no database query', !r.err && r.res.body.data.favorited.length === 0 && calls.length === 0);
  r = await run({ user: { id: 'u1' }, query: {} });
  check('no ids: empty list and no database query', !r.err && r.res.body.data.favorited.length === 0 && calls.length === 0);
  r = await run({ user: { id: 'u1' }, query: { ids: ' p1 ,p1,,p3,' + 'x'.repeat(65) } });
  check('ids are trimmed, de-duplicated, and over-long ones dropped', calls.at(-1).where.productId.in.join('|') === 'p1|p3');
  const many = Array.from({ length: 100 }, (_, i) => `id${i}`).join(',');
  await run({ user: { id: 'u1' }, query: { ids: many } });
  check('at most 60 ids are queried', calls.at(-1).where.productId.in.length === 60);

  // ---- frontend: the real method, extracted from js/store-detail.js -------------
  const src = fs.readFileSync(path.join(ROOT, 'js', 'store-detail.js'), 'utf8');
  const start = src.indexOf('async loadFavoriteStates()');
  let depth = 0, i = src.indexOf('{', start), end = i;
  for (; end < src.length; end++) { if (src[end] === '{') depth++; else if (src[end] === '}' && --depth === 0) break; }
  const method = new Function('app', `return { ${src.slice(start, end + 1)} }.loadFavoriteStates;`);

  const mkPage = (n) => ({ products: Array.from({ length: n }, (_, k) => ({ id: `p${k + 1}` })), hearts: [], setHeart(id, on) { this.hearts.push([id, on]); } });
  const mkApp = (token, backend) => { const reqs = []; return { reqs, token, apiRequest: async (url) => { reqs.push(url); return backend(url); } }; };
  const newBackend = url => url.startsWith('/favorites/check') ? { data: { favorited: ['p1', 'p3'] } } : { data: { favorited: false } };
  const oldBackend = url => { const id = url.split('/')[2]; return { data: { favorited: ['p1', 'p3'].includes(id) } }; }; // no /check: 'check?ids=..' is read as a product id

  let app = mkApp('tok', newBackend), pg = mkPage(24);
  await method(app).call(pg);
  check('a page of 24 products makes ONE favorites request', app.reqs.length === 1 && /^\/favorites\/check\?ids=p1,p2,/.test(app.reqs[0]));
  check('only the saved products get a filled heart', JSON.stringify(pg.hearts) === '[["p1",true],["p3",true]]');
  app.reqs.length = 0; await method(app).call(pg);
  check('a second call for the same products (filter change) makes no request', app.reqs.length === 0);
  pg.products.push({ id: 'p25' }); await method(app).call(pg);
  check('"Load more" only asks about the new products', app.reqs.length === 1 && /ids=p25$/.test(app.reqs[0]));

  app = mkApp(null, newBackend); pg = mkPage(24); await method(app).call(pg);
  check('signed-out visitors make no favorites requests', app.reqs.length === 0);

  app = mkApp('tok', oldBackend); pg = mkPage(5); await method(app).call(pg);
  check('against a backend without /check it falls back to one request per card and still paints the right hearts',
    app.reqs.length === 6 && app.reqs[0].startsWith('/favorites/check') && JSON.stringify(pg.hearts.sort()) === '[["p1",true],["p3",true]]');

  app = mkApp('tok', () => { throw new Error('network'); }); pg = mkPage(3);
  let threw = false; try { await method(app).call(pg); } catch (e) { threw = true; }
  check('a failing lookup never throws into the page', !threw);

  const failed = results.filter(x => !x.ok);
  results.forEach(x => console.log(`${x.ok ? 'PASS' : 'FAIL'}  ${x.name}${x.ok || !x.detail ? '' : `\n      ${x.detail}`}`));
  console.log(`\n${results.length - failed.length}/${results.length} favorites-bulk checks passed.`);
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
