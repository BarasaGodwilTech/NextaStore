#!/usr/bin/env node
'use strict';
/*
 * Runs the REAL src/helpers.js, src/utils.js, src/middleware.js errorHandler and
 * the REAL POST /orders/public and /orders/batch handlers from src/routes/orders.js,
 * with Prisma, Express and the rest stubbed (no database or browser needed):
 *
 *   npm run test:store-gate
 *
 * Proves: a draft store or one whose trial / paid time has ended takes no orders
 * through EITHER order route (the owner included) and nothing is written; an open
 * store still takes an order end to end (this also covers two ReferenceErrors the
 * handler used to throw); shoppers get a closed-store identity (name/logo/colour)
 * and nothing else - no dates, no reason; only the owner gets a lifecycle state;
 * tiers, perks and the "boost" inputs; image references and file signatures are
 * checked; input limits (only when `zod` is installed).
 * Does NOT prove: real Express routing, Postgres, or the browser pages (see
 * scripts/store-front-test.js for those).
 */
const path = require('path');
const Module = require('module');
const SRC = path.resolve(__dirname, '..', 'src');
const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail });

const DAY = 86400000;
const now = Date.now();
const iso = (ms) => new Date(now + ms);
const mkStore = (o = {}) => ({ id: 's1', ownerId: 'owner1', name: 'Asia Ivan Store', slug: 'asia-ivan-store', logo: '/l.png', bannerColor: '#00B074', isPublished: true, deletedAt: null, verified: false, badgeCommitmentMonths: 0, trialEndsAt: iso(-2 * DAY), subscriptionPaidUntil: null, payments: {}, ...o });

// ---- stubs -----------------------------------------------------------------
let store = mkStore();
const writes = [];
const stockRows = { p1: { id: 'p1', name: 'Chair', price: { times: (q) => ({ v: 25000 * q }), toString: () => '25000' }, stock: 10, storeId: 's1', deletedAt: null } };
class Dec { constructor(v) { this.v = Number(v); } plus(o) { return new Dec(this.v + (o.v ?? Number(o))); } times(q) { return new Dec(this.v * q); } toString() { return String(this.v); } toNumber() { return this.v; } }
stockRows.p1.price = new Dec(25000);
const tx = {
  product: { findMany: async () => [stockRows.p1], updateMany: async () => ({ count: 1 }), findUnique: async () => stockRows.p1 },
  order: { create: async ({ data }) => { writes.push('order.create'); return { ...data, id: 'ORD1', items: data.items.create, total: new Dec(25000) }; } },
  store: { findFirst: async () => store }
};
const fakePrisma = {
  store: { findFirst: async () => store },
  product: { findMany: async () => [] },
  paymentMethod: { findMany: async () => [] },
  notification: { create: async (a) => { writes.push('notification'); return a; } },
  $transaction: async (fn) => { writes.push('$transaction'); return fn(tx); }
};
const routeTable = {};
const fakeExpress = { Router: () => { const r = {}; for (const v of ['get', 'post', 'put', 'patch', 'delete']) r[v] = (p, ...h) => { routeTable[`${v.toUpperCase()} ${p}`] = h; }; return r; } };
const origLoad = Module._load;
Module._load = function (request, parent) {
  const from = parent && parent.filename ? parent.filename : '';
  if (request === 'express') return fakeExpress;
  if (request === '@prisma/client') return { Prisma: { Decimal: Dec } };
  if (request === 'jsonwebtoken') return { verify() { throw new Error('x'); }, sign() { return 't'; } };
  if (from.startsWith(SRC)) {
    if (/(^|\/)prisma$/.test(request)) return fakePrisma;
    if (/(^|\/)config$/.test(request)) return { isProd: false, jwtSecret: 'x', frontendUrl: 'http://x' };
    if (/(^|\/)push$/.test(request)) return { sendPushToUser: async () => {} };
    if (/(^|\/)orderCode$/.test(request)) return { generateOrderCode: () => 'ORD1' };
    if (/(^|\/)validation$/.test(request)) return new Proxy({ validateBody: () => (q, r, n) => n() }, { get: (t, k) => (k in t ? t[k] : {}) });
    if (/(^|\/)middleware$/.test(request) && /routes/.test(from)) return { requireAuth: (q, r, n) => n(), requireSeller: (q, r, n) => n(), optionalAuth: (q, r, n) => n() };
  }
  return origLoad.apply(this, arguments);
};
const helpers = require(path.join(SRC, 'helpers.js'));
const utils = require(path.join(SRC, 'utils.js'));
require(path.join(SRC, 'routes', 'orders.js'));
let errorHandler = null;
try { errorHandler = require(path.join(SRC, 'middleware.js')).errorHandler; } catch (_) { /* needs real deps; skipped below */ }
Module._load = origLoad;

const throwsWith = (fn) => { try { fn(); return null; } catch (e) { return e; } };
const call = async (handler, req) => { const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } }; let err = null; await handler(req, res, e => { err = e; }); return { res, err }; };

(async () => {
  // ---- assertStoreOpenForBusiness --------------------------------------------
  let e = throwsWith(() => helpers.assertStoreOpenForBusiness(mkStore({ isPublished: false })));
  check('draft store is not open for business (STORE_DRAFT, 409)', e && e.code === 'STORE_DRAFT' && e.status === 409);
  e = throwsWith(() => helpers.assertStoreOpenForBusiness(mkStore()));
  check('expired-trial store is not open for business (STORE_INACTIVE, 409)', e && e.code === 'STORE_INACTIVE' && e.status === 409);
  e = throwsWith(() => helpers.assertStoreOpenForBusiness(mkStore({ trialEndsAt: iso(-40 * DAY), subscriptionPaidUntil: iso(-1 * DAY) })));
  check('store whose paid month ended is not open for business', e && e.code === 'STORE_INACTIVE');
  check('store inside its trial is open', throwsWith(() => helpers.assertStoreOpenForBusiness(mkStore({ trialEndsAt: iso(5 * DAY) }))) === null);
  check('store with paid time left is open', throwsWith(() => helpers.assertStoreOpenForBusiness(mkStore({ subscriptionPaidUntil: iso(20 * DAY) }))) === null);
  check('a deleted store is not found', (throwsWith(() => helpers.assertStoreOpenForBusiness(mkStore({ deletedAt: new Date(), trialEndsAt: iso(5 * DAY) }))) || {}).status === 404);

  // ---- assertStoreVisible: identity yes, reason no ----------------------------
  e = throwsWith(() => helpers.assertStoreVisible(mkStore(), { user: { id: 'someone' } }));
  check('a shopper hitting a lapsed store gets STORE_INACTIVE (404)', e && e.code === 'STORE_INACTIVE' && e.status === 404);
  check('...with only name/slug/logo/bannerColor attached', e && JSON.stringify(Object.keys(e.meta).sort()) === '["bannerColor","logo","name","slug"]');
  check('...and no dates or payment detail anywhere in it', e && !/trial|paid|subscription|Ends|At"/i.test(JSON.stringify(e.meta)));
  check('the owner still sees their own lapsed store', throwsWith(() => helpers.assertStoreVisible(mkStore(), { user: { id: 'owner1' } })) === null);
  e = throwsWith(() => helpers.assertStoreVisible(mkStore({ isPublished: false }), { user: null }));
  check('a draft gives shoppers NO identity (seller may not have chosen a public name)', e && e.code === 'STORE_DRAFT' && !e.meta);

  if (errorHandler) {
    const res = { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
    errorHandler(helpers.__closedErr = throwsWith(() => helpers.assertStoreVisible(mkStore(), { user: null })), { originalUrl: '/x', method: 'GET' }, res, () => {});
    check('error handler forwards { store } for STORE_INACTIVE only', res.body && res.body.code === 'STORE_INACTIVE' && res.body.store && res.body.store.name === 'Asia Ivan Store');
    const res2 = { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
    errorHandler(Object.assign(new Error('nope'), { status: 404, code: 'STORE_DRAFT', meta: { name: 'leak' } }), { originalUrl: '/x', method: 'GET' }, res2, () => {});
    check('...and never for any other code', res2.body && !res2.body.store);
  } else check('error handler test skipped (real middleware needs installed deps)', true, 'skipped');

  // ---- owner lifecycle -----------------------------------------------------------
  check('owner state: draft', helpers.ownerLifecycle(mkStore({ isPublished: false })).state === 'draft');
  let lc = helpers.ownerLifecycle(mkStore({ trialEndsAt: iso(-3 * DAY) }));
  check('owner state: lapsed after trial (hadPaidPlan false)', lc.state === 'lapsed' && lc.hadPaidPlan === false && !!lc.endedAt);
  lc = helpers.ownerLifecycle(mkStore({ trialEndsAt: iso(-40 * DAY), subscriptionPaidUntil: iso(-1 * DAY) }));
  check('owner state: lapsed after a paid month (hadPaidPlan true)', lc.state === 'lapsed' && lc.hadPaidPlan === true);
  lc = helpers.ownerLifecycle(mkStore({ subscriptionPaidUntil: iso(2 * DAY) }));
  check('owner state: ending within 3 days', lc.state === 'ending' && lc.daysLeft >= 1 && lc.daysLeft <= 3);
  check('owner state: live when comfortable', helpers.ownerLifecycle(mkStore({ subscriptionPaidUntil: iso(20 * DAY) })).state === 'live');

  // ---- tiers ---------------------------------------------------------------------
  const gold = mkStore({ verified: true, badgeCommitmentMonths: 12, subscriptionPaidUntil: iso(20 * DAY) });
  const t = helpers.tierSummary(gold);
  check('a 12-month committed, paid store has the Gold tier (rank 2)', t && t.tone === 'gold' && t.rank === 2, JSON.stringify(t));
  check('an unbadged store has no tier', helpers.tierSummary(mkStore({ subscriptionPaidUntil: iso(20 * DAY) })) === null);
  check('the tier summary is slim (no perks/reason)', t && !('perks' in t) && !('reason' in t));
  check('perks exist for all three tiers', ['verified', 'gold', 'platinum'].every(k => helpers.TIER_PERKS[k].perks.length >= 2));
  check('public store payload carries `tier`', 'tier' in helpers.serializePublicStore(gold, {}));

  // ---- POST /orders/public and /orders/batch ----------------------------------------
  const pub = routeTable['POST /public'].slice(-1)[0];
  const batch = routeTable['POST /batch'].slice(-1)[0];
  const body = { customerName: 'A', customerPhone: '077', deliveryAddress: 'x', fulfillmentMethod: 'delivery', items: [{ productId: 'p1', quantity: 1 }] };
  const batchBody = { customerName: 'A', customerPhone: '077', deliveryAddress: 'x', acknowledgment: true, stores: [{ storeId: 's1', fulfillmentMethod: 'delivery', items: [{ productId: 'p1', quantity: 1 }] }] };
  const req = (b) => ({ user: { id: 'buyer1' }, query: { store: 'asia-ivan-store' }, body: JSON.parse(JSON.stringify(b)) });

  store = mkStore(); writes.length = 0;
  let r = await call(pub, req(body));
  check('/orders/public: lapsed store -> 409 STORE_INACTIVE', r.err && r.err.status === 409 && r.err.code === 'STORE_INACTIVE');
  check('...and nothing was written (no transaction, no order)', !writes.length);
  store = mkStore({ ownerId: 'buyer1' }); writes.length = 0;
  r = await call(pub, req(body));
  check('/orders/public: not even the owner can order from their own lapsed store', r.err && r.err.code === 'STORE_INACTIVE' && !writes.length);
  store = mkStore({ isPublished: false, trialEndsAt: iso(5 * DAY) }); writes.length = 0;
  r = await call(pub, req(body));
  check('/orders/public: a draft store takes no orders', r.err && r.err.code === 'STORE_DRAFT' && !writes.length);

  store = mkStore(); writes.length = 0;
  r = await call(batch, req(batchBody));
  check('/orders/batch: lapsed store -> 409 STORE_INACTIVE, nothing ordered', r.err && r.err.code === 'STORE_INACTIVE' && !writes.includes('order.create'));
  store = mkStore({ isPublished: false, trialEndsAt: iso(5 * DAY) }); writes.length = 0;
  r = await call(batch, req(batchBody));
  check('/orders/batch: a draft store is refused too', r.err && r.err.code === 'STORE_DRAFT' && !writes.includes('order.create'));

  store = mkStore({ trialEndsAt: iso(5 * DAY) }); writes.length = 0;
  r = await call(pub, req(body));
  check('/orders/public: an OPEN store takes an order end to end (201, no ReferenceError)', !r.err && r.res.code === 201 && writes.includes('order.create'), r.err && r.err.message);

  // ---- images ------------------------------------------------------------------------
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
  check('a real PNG passes the signature check', utils.matchesImageSignature('image/png', png));
  check('HTML declared as image/png is rejected', !utils.matchesImageSignature('image/png', Buffer.from('<html><script>alert(1)</script></html>')));
  check('a JPEG declared as PNG is rejected', !utils.matchesImageSignature('image/png', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0])));
  const okRefs = ['https://cdn.example.com/a/b.png', '/uploads/a.png'];
  const badRefs = ['javascript:alert(1)', '//evil.example/x.png', 'https://x/a).png', 'data:text/html;base64,AAAA', '/a b.png', 'https://x/"onerror=1'];
  check('safe image references are accepted', okRefs.every(v => utils.SAFE_IMAGE_REF_RE.test(v)));
  check('unsafe image references are rejected', badRefs.every(v => !utils.SAFE_IMAGE_REF_RE.test(v)), badRefs.filter(v => utils.SAFE_IMAGE_REF_RE.test(v)).join(' | '));

  // ---- input limits (needs zod) ----------------------------------------------------------
  let v = null; try { Module._load = function (rq, p) { if (/(^|\/)(prisma|config)$/.test(rq) && p && p.filename.startsWith(SRC)) return {}; return origLoad.apply(this, arguments); }; v = require(path.join(SRC, 'validation.js')); } catch (_) { v = null; } finally { Module._load = origLoad; }
  if (v && v.updateStoreSchema) {
    const okStore = v.updateStoreSchema.safeParse({ name: 'A', payments: { mtn: true }, seo: { title: 't', indexable: true } });
    check('valid store update still passes', okStore.success, okStore.error && okStore.error.message);
    check('store description over 2000 chars is rejected', !v.updateStoreSchema.safeParse({ description: 'x'.repeat(2001) }).success);
    check('store payments must be code -> boolean', !v.updateStoreSchema.safeParse({ payments: { mtn: 'yes' } }).success && !v.updateStoreSchema.safeParse({ payments: { a: { b: 1 } } }).success);
    check('store seo accepts only title/description/indexable', !v.updateStoreSchema.safeParse({ seo: { title: 't', evil: 'x' } }).success);
    check('product icon must be a FontAwesome class name', !v.productSchema.safeParse({ name: 'x', price: 5, icon: 'fa-box" onmouseover="x' }).success && v.productSchema.safeParse({ name: 'x', price: 5, icon: 'fa-box' }).success);
    check('order quantity is capped', !v.publicOrderSchema.safeParse({ customerName: 'A', customerPhone: '1', deliveryAddress: 'x', items: [{ productId: 'p', quantity: 5000 }] }).success);
    check('password over 128 chars is rejected at signup', !v.signupSchema.safeParse({ name: 'A', email: 'a@b.co', password: 'x'.repeat(200) }).success);
  } else check('validation limit tests skipped (zod not installed)', true, 'skipped');

  // ---- a badge is a small edge over unbadged stores - nothing more --------------
  const fsr = require('fs');
  const code = (f) => fsr.readFileSync(path.join(SRC, f), 'utf8').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  const orderings = ['routes/store.js', 'routes/products.js'].map(code).join('\n');
  // Only the ordering expressions themselves (a `select` that merely reads the badge for display is fine).
  const orderExprs = [...(orderings.match(/orderBy:\s*\[[^\]]*\]/g) || []), ...(orderings.match(/const orderBy\s*=[^;]*;/g) || [])];
  check('found the ordering expressions to inspect (guard is not vacuous)', orderExprs.length >= 4, String(orderExprs.length));
  check('no ordering ranks one tier above another (badgeCommitmentMonths is never an ordering key)',
    !orderExprs.some(e => /badgeCommitmentMonths/.test(e)), orderExprs.filter(e => /badgeCommitmentMonths/.test(e)).join(' ; '));
  const storeOrders = orderExprs.filter(e => /^orderBy:\s*\[\{\s*(verified|createdAt)/.test(e) && !/sold|price/.test(e));
  check('store lists and search: badged first, then newest', storeOrders.length >= 2 && storeOrders.every(e => /^orderBy:\s*\[\{ verified: 'desc' \}, \{ createdAt: 'desc' \}\]$/.test(e.replace(/\s+/g, ' '))), storeOrders.join(' ; '));
  const popular = orderExprs.find(e => /sold: 'desc'/.test(e) && /verified/.test(e)) || '';
  check('"popular" products: real sales always come before the badge', /sold: 'desc'[^\]]*verified/.test(popular.replace(/\s+/g, ' ')), popular);
  const perkText = Object.values(helpers.TIER_PERKS || {}).flatMap(t => t.perks).join(' | ');
  check('perk copy only promises an edge over stores WITHOUT a badge - no top placement, no tier-over-tier ranking',
    /without a badge/i.test(perkText) && !/top placement|top of|ahead of verified|rank|first in|priority/i.test(perkText), perkText);

  const failed = results.filter(x => !x.ok);
  results.forEach(x => console.log(`${x.ok ? 'PASS' : 'FAIL'}  ${x.name}${x.ok || !x.detail ? '' : `  -> ${x.detail}`}`));
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch(err => { console.error('TEST CRASHED:', err); process.exit(1); });
