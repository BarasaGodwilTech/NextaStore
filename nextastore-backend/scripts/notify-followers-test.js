#!/usr/bin/env node
'use strict';
/*
 * Runs the REAL src/helpers.js#notifyStoreFollowersOfNewProduct and the REAL
 * POST /api/products route (src/routes/products.js) with Express, Prisma,
 * web-push and config all stubbed out -- same Module._load interception
 * pattern as push-backend-test.js, so this needs no node_modules, database
 * or network:
 *
 *   npm run test:new-product-notify
 *
 * src/utils.js is loaded FOR REAL (not stubbed) since every payload here
 * uses images: [], which makes saveImagePairsIfDataUrls a same-turn no-op —
 * that's worth exercising rather than faking away entirely.
 */
const path = require('path');
const Module = require('module');

const SRC = path.resolve(__dirname, '..', 'src');
const results = [];
function check(name, ok, detail = '') { results.push({ name, ok: !!ok, detail }); }

// ---- fake database -------------------------------------------------------------
const db = { stores: [], products: [], follows: [], notifications: [], subs: [] };
let seq = 1;
function addStore(s) { const row = { followers: 0, ...s }; db.stores.push(row); return row; }
function addFollow(userId, storeId) { db.follows.push({ userId, storeId }); }
function addSub(userId, endpoint) { db.subs.push({ id: `s${seq++}`, userId, endpoint, p256dh: `p-${endpoint}`, auth: `a-${endpoint}` }); }
function reset() { db.stores = []; db.products = []; db.follows = []; db.notifications = []; db.subs = []; pushed.length = 0; }

// ---- stubs ----------------------------------------------------------------------
let followersGate = null; // when set, storeFollow.findMany awaits it before resolving

const fakePrisma = {
    store: {
        findUnique: async ({ where }) => {
            if (where.ownerId !== undefined) return db.stores.find(s => s.ownerId === where.ownerId) || null;
            if (where.id !== undefined) return db.stores.find(s => s.id === where.id) || null;
            return null;
        }
    },
    product: {
        create: async ({ data }) => {
            const row = { rating: 0, reviews: 0, sold: 0, createdAt: new Date(), updatedAt: new Date(), deletedAt: null, ...data };
            db.products.push(row);
            return row;
        }
    },
    storeFollow: {
        findMany: async ({ where }) => {
            if (followersGate) await followersGate;
            return db.follows
                .filter(f => f.storeId === where.storeId)
                .filter(f => !where.userId || f.userId !== where.userId.not)
                .map(f => ({ userId: f.userId }));
        }
    },
    notification: {
        createMany: async ({ data }) => { db.notifications.push(...data); return { count: data.length }; }
    },
    pushSubscription: {
        findMany: async ({ where }) => db.subs.filter(s => s.userId === where.userId).map(s => ({ ...s }))
    }
};

const pushed = [];
const fakeWebpush = {
    setVapidDetails: () => {},
    sendNotification: async (sub, payload) => { pushed.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) }); }
};

const fakeConfig = { pushEnabled: true, vapid: { subject: 'mailto:t@t.test', publicKey: 'pub', privateKey: 'priv' }, r2Enabled: false };

function apiError(message, status = 400, code = null) { const e = new Error(message); e.status = status; if (code) e.code = code; return e; }

const routeTable = {};
const fakeExpress = {
    Router: () => {
        const r = {};
        for (const verb of ['get', 'post', 'put', 'delete']) r[verb] = (p, ...handlers) => { routeTable[`${verb.toUpperCase()} ${p}`] = handlers; };
        return r;
    }
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
    const from = parent && parent.filename ? parent.filename : '';
    const inSrc = from.startsWith(SRC);
    if (request === 'express') return fakeExpress;
    if (request === 'web-push') return fakeWebpush;
    if (inSrc) {
        if (/(^|\/)prisma$/.test(request)) return fakePrisma;
        if (/(^|\/)config$/.test(request)) return fakeConfig;
        if (/(^|\/)middleware$/.test(request)) return { requireAuth: (req, res, next) => next(), requireSeller: (req, res, next) => next(), optionalAuth: (req, res, next) => next() };
        if (/(^|\/)validation$/.test(request)) return { validateBody: () => (req, res, next) => next(), productSchema: {}, productUpdateSchema: {} };
        if (/(^|\/)cacheMiddleware$/.test(request)) return { cacheResponse: () => (req, res, next) => next() };
        // Deliberately NOT stubbing '../utils' or './push': both load for
        // real, backed only by the fakes above (config, prisma, web-push).
    }
    return origLoad.apply(this, arguments);
};

const { notifyStoreFollowersOfNewProduct } = require(path.join(SRC, 'helpers.js'));
require(path.join(SRC, 'routes', 'products.js'));

async function call(routeKey, { userId, body = {} } = {}) {
    const handlers = routeTable[routeKey];
    if (!handlers) throw new Error(`route ${routeKey} not registered`);
    const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    let error = null;
    const req = { user: { id: userId }, body };
    for (const h of handlers) {
        let advanced = false;
        await h(req, res, (err) => { advanced = true; if (err) error = err; });
        if (error || !advanced) break;
    }
    return { status: error ? (error.status || 500) : res.statusCode, error, body: res.body };
}

function flush(n = 3) {
    let p = Promise.resolve();
    for (let i = 0; i < n; i++) p = p.then(() => new Promise(r => setTimeout(r, 0)));
    return p;
}

(async () => {
    const realConsoleError = console.error;
    console.error = () => {}; // notifyStoreFollowersOfNewProduct logs failures on purpose

    // ------------------------------------------------ notifyStoreFollowersOfNewProduct, direct
    reset();
    addFollow('f1', 'store1'); addFollow('f2', 'store1'); addFollow('f3', 'other-store');
    addSub('f1', 'https://push.example/f1-phone'); addSub('f2', 'https://push.example/f2-phone');
    await notifyStoreFollowersOfNewProduct({ storeId: 'store1', storeName: 'Kampala Kicks', storeSlug: 'kampala-kicks', storeOwnerId: 'owner1', productId: 'prod1', productName: 'Air Max 90' });

    check('Writes exactly one notification row per follower of that store, no more',
        db.notifications.length === 2 && db.notifications.every(n => n.userId === 'f1' || n.userId === 'f2'));
    check('Does not touch a follower of a different store', !db.notifications.some(n => n.userId === 'f3'));
    check('Every row has the right type, a title naming the store, and the product as the body',
        db.notifications.every(n => n.type === 'new_product' && n.title === 'Kampala Kicks added a new product' && n.body === 'Air Max 90'));
    check('The link points at the product with the store slug for context', db.notifications.every(n => n.link === 'product-detail.html?id=prod1&store=kampala-kicks'));
    check('Push goes out to every follower, not just the first', pushed.length === 2 && pushed.some(p => p.endpoint.includes('f1')) && pushed.some(p => p.endpoint.includes('f2')));
    check('The push payload matches the notification exactly', pushed.every(p => p.payload.type === 'new_product' && p.payload.title === 'Kampala Kicks added a new product' && p.payload.link === 'product-detail.html?id=prod1&store=kampala-kicks'));

    // ------------------------------------------------------------- owner exclusion
    reset();
    addFollow('owner1', 'store1'); addFollow('f1', 'store1'); // the owner also happens to follow their own store
    await notifyStoreFollowersOfNewProduct({ storeId: 'store1', storeName: 'Kampala Kicks', storeSlug: 'kampala-kicks', storeOwnerId: 'owner1', productId: 'prod1', productName: 'Air Max 90' });
    check('The store\u2019s own owner never gets "your store added a product" even if they follow it', !db.notifications.some(n => n.userId === 'owner1') && db.notifications.length === 1);

    // ------------------------------------------------------------- no followers
    reset();
    await notifyStoreFollowersOfNewProduct({ storeId: 'lonely-store', storeName: 'New Shop', storeSlug: 'new-shop', storeOwnerId: 'owner2', productId: 'p2', productName: 'First Item' });
    check('A brand-new store with no followers writes nothing and sends nothing', db.notifications.length === 0 && pushed.length === 0);

    // ------------------------------------------------------------- title truncation
    reset();
    addFollow('f1', 'store1');
    const longName = 'X'.repeat(150);
    await notifyStoreFollowersOfNewProduct({ storeId: 'store1', storeName: 'Shop', storeSlug: 'shop', storeOwnerId: null, productId: 'p3', productName: longName });
    check('A very long product name is truncated in the body, same 120-char convention as message previews',
        db.notifications[0].body.length === 120 && db.notifications[0].body.endsWith('...'));

    // ------------------------------------------------------------- never throws
    reset();
    followersGate = null;
    const brokenFindMany = fakePrisma.storeFollow.findMany;
    fakePrisma.storeFollow.findMany = async () => { throw new Error('database down'); };
    let threw = false;
    try { await notifyStoreFollowersOfNewProduct({ storeId: 's', storeName: 'S', storeSlug: 's', storeOwnerId: null, productId: 'p', productName: 'P' }); } catch (e) { threw = true; }
    check('A database failure never throws out of notifyStoreFollowersOfNewProduct (fire-and-forget callers rely on it)', !threw);
    fakePrisma.storeFollow.findMany = brokenFindMany;

    // ------------------------------------------------------------- POST /products wiring
    reset();
    addStore({ id: 'store1', ownerId: 'sellerA', name: 'Kampala Kicks', slug: 'kampala-kicks' });
    addFollow('f1', 'store1'); addFollow('f2', 'store1');
    addSub('f1', 'https://push.example/f1-phone');

    let res = await call('POST /', { userId: 'sellerA', body: { name: 'Air Max 90', description: 'Fresh pair', price: 250000, category: 'shoes', icon: 'fa-shoe-prints', stock: 5, images: [], thumbnails: [] } });
    check('POST /products still succeeds and returns the created product', res.status === 201 && res.body.data.name === 'Air Max 90');
    await flush();
    check('...and it also notified this store\u2019s followers, wired end to end through the real route', db.notifications.length === 2 && db.notifications.every(n => n.type === 'new_product'));

    // ------------------------------------------------------ not awaited: the real point of firing-and-forgetting
    reset();
    addStore({ id: 'store2', ownerId: 'sellerB', name: 'Jinja Threads', slug: 'jinja-threads' });
    for (let i = 0; i < 25; i++) addFollow(`follower${i}`, 'store2');
    let release;
    followersGate = new Promise(r => { release = r; });

    const before = Date.now();
    const raced = await Promise.race([
        call('POST /', { userId: 'sellerB', body: { name: 'Ankara Shirt', description: '', price: 45000, category: 'clothing', icon: 'fa-shirt', stock: 10, images: [], thumbnails: [] } })
            .then(r => ({ timedOut: false, res: r })),
        // If a regression makes the route await the fan-out, call() above
        // hangs on the still-pending followersGate forever. With nothing
        // else scheduled, Node's event loop would simply drain and the
        // process would exit quietly with no further output at all --
        // exactly the kind of silent, unhelpful non-failure a test suite
        // must not produce. This timer is what turns that into a normal,
        // loud FAIL instead.
        new Promise(resolve => setTimeout(() => resolve({ timedOut: true }), 300))
    ]);
    const roundTripMs = Date.now() - before;

    if (raced.timedOut) {
        check('The response comes back immediately, without waiting on the follower fan-out', false, 'timed out after 300ms — the route now appears to await the fan-out');
        check('...proven, not just fast: the fan-out genuinely has not run yet at the moment the response returns', false, 'skipped: previous check timed out');
        check('...but it does complete shortly after, in the background, for all 25 followers', false, 'skipped: previous check timed out');
        release(); // let the now-irrelevant pending call finish in the background so nothing lingers
    } else {
        res = raced.res;
        check('The response comes back immediately, without waiting on the follower fan-out', res.status === 201 && roundTripMs < 50, `took ${roundTripMs}ms`);
        check('...proven, not just fast: the fan-out genuinely has not run yet at the moment the response returns', db.notifications.length === 0);
        release();
        await flush();
        check('...but it does complete shortly after, in the background, for all 25 followers', db.notifications.length === 25);
    }
    followersGate = null;

    console.error = realConsoleError;

    let failed = 0;
    for (const r of results) {
        console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok || !r.detail ? '' : ` — ${r.detail}`}`);
        if (!r.ok) failed++;
    }
    console.log(`\n${results.length - failed}/${results.length} new-product-follower-notification checks passed.`);
    process.exit(failed ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
