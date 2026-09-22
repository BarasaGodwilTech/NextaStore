#!/usr/bin/env node
'use strict';
/*
 * Runs the REAL src/presence.js and src/routes/presence.js (and the presence
 * parts of src/middleware.js) with Express, Prisma, Redis and config stubbed,
 * so it needs no node_modules, database or network:
 *
 *   npm run test:presence
 *
 * Proves: online/offline state, the flicker-free grace period, last-active
 * saving, watch authorisation, the SSE wire format and headers, session
 * revocation, shutdown, the Redis fan-out logic against a FAKE Redis, and that
 * presence traffic never renews a session. Does NOT prove: real Express
 * mounting, real ioredis behaviour, the raw SQL against Postgres, or that
 * compression() honours no-transform (checked statically in qa-static.js).
 */
const path = require('path');
const Module = require('module');
const { EventEmitter } = require('events');
const SRC = path.resolve(__dirname, '..', 'src');
const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- stubs -----------------------------------------------------------------
const db = { persisted: [], conversations: [], stores: [] };
const fakePrisma = {
    $executeRaw: async (_s, date, ids) => { db.persisted.push({ ids, date }); },
    conversation: { findMany: async ({ where }) => db.conversations.filter((c) => where.id.in.includes(c.id) && (c.buyerId === where.OR[0].buyerId || c.store.ownerId === where.OR[1].store.ownerId)) },
    store: { findMany: async ({ where }) => db.stores.filter((s) => where.slug.in.includes(s.slug)), findFirst: async ({ where }) => db.stores.find((s) => s.slug === where.slug) || null }
};
const routeTable = {};
const fakeExpress = { Router: () => { const r = {}; for (const v of ['get', 'post']) r[v] = (p, ...h) => { routeTable[`${v.toUpperCase()} ${p}`] = h; }; return r; } };
function apiError(message, status = 400) { const e = new Error(message); e.status = status; return e; }
const future = () => new Date(Date.now() + 86400000);
const origLoad = Module._load;
Module._load = function (request, parent) {
    const from = parent && parent.filename ? parent.filename : '';
    if (request === 'express') return fakeExpress;
    if (request === '@prisma/client') return { Prisma: { join: (ids) => ids } };
    if (from.startsWith(SRC)) {
        if (/(^|\/)prisma$/.test(request)) return fakePrisma;
        if (/(^|\/)cache$/.test(request)) return { redisClient: null };
        if (/(^|\/)middleware$/.test(request)) return { requireAuth: (req, res, next) => next() };
        if (/(^|\/)utils$/.test(request)) return { apiError };
        if (/(^|\/)helpers$/.test(request)) return { isStoreCurrentlyActive: (s) => !!s.trialEndsAt && new Date(s.trialEndsAt) > new Date() };
        if (/(^|\/)validation$/.test(request)) return { validateBody: () => (req, res, next) => next(), presenceStreamSchema: {} };
    }
    return origLoad.apply(this, arguments);
};
const realWarn = console.warn; console.warn = () => {};
const shared = require(path.join(SRC, 'presence.js'));
const { createPresence } = shared;
require(path.join(SRC, 'routes', 'presence.js'));
const middlewareSource = require('fs').readFileSync(path.join(SRC, 'middleware.js'), 'utf8');
console.warn = realWarn;

const mkHandle = () => { const h = { events: [], pings: 0, closed: null, send: (e, d) => { h.events.push([e, d]); }, ping: () => { h.pings++; }, close: (r) => { h.closed = r; } }; return h; };
const quiet = { warn() {}, error() {} };
const mk = (o = {}) => { const saved = []; const p = createPresence({ persist: async (ids, date) => { saved.push({ ids, date }); }, options: { graceMs: 40, heartbeatMs: 20, ...o }, log: quiet }); return { p, saved }; };

(async () => {
    // ---- engine: online, grace, offline, last active ---------------------------
    {
        const { p, saved } = mk();
        const watcher = mkHandle(); const wc = p.connect('viewer', watcher);
        const snap = await p.watch(wc, [['conversation:c1', 'alice']]);
        check('a person nobody has seen is offline with no last-active time', snap['conversation:c1'].online === false && snap['conversation:c1'].lastActiveAt === null);
        const a = mkHandle(); const ac = p.connect('alice', a);
        check('connecting announces online to watchers', watcher.events.some(([e, d]) => e === 'presence' && d.key === 'conversation:c1' && d.online === true && typeof d.at === 'number'));
        p.disconnect(ac);
        await sleep(10);
        check('closing the last stream does NOT announce offline straight away (grace period)', !watcher.events.some(([e, d]) => e === 'presence' && d.online === false));
        const a2 = mkHandle(); const ac2 = p.connect('alice', a2);
        await sleep(70);
        check('reconnecting inside the grace period means nobody ever sees offline', !watcher.events.some(([e, d]) => e === 'presence' && d.online === false) && saved.length === 0);
        p.disconnect(ac2);
        await sleep(90);
        const off = watcher.events.filter(([e, d]) => e === 'presence' && d.online === false);
        check('offline is announced once the grace period passes, carrying last-active', off.length === 1 && !!off[0][1].lastActiveAt);
        check('last-active is saved to the database on going offline', saved.length === 1 && saved[0].ids[0] === 'alice');
        const later = await p.describe([{ id: 'alice', lastActiveAt: new Date(0) }]);
        check('describe prefers the fresher in-memory time over an older stored one', new Date(later.get('alice').lastActiveAt).getTime() > 1000);
        const stored = await p.describe([{ id: 'zed', lastActiveAt: '2026-09-01T00:00:00.000Z' }]);
        check('describe falls back to the stored time for people this process never saw', stored.get('zed').lastActiveAt === '2026-09-01T00:00:00.000Z' && stored.get('zed').online === false);
        const on = mkHandle(); const onc = p.connect('bob', on);
        const d = await p.describe([{ id: 'bob', lastActiveAt: new Date() }]);
        check('an online person reports online with no last-active time', d.get('bob').online === true && d.get('bob').lastActiveAt === null);
        p.disconnect(onc);
        await p.shutdown();
    }
    // ---- engine: multi-tab, caps, revocation, aging, shutdown --------------------
    {
        const { p, saved } = mk({ maxStreamsPerUser: 2, maxStreamAgeMs: 60 });
        const w = mkHandle(); const wc = p.connect('viewer', w); await p.watch(wc, [['store:s', 'seller']]);
        const t1 = mkHandle(), t2 = mkHandle(), t3 = mkHandle();
        const c1 = p.connect('seller', t1); const c2 = p.connect('seller', t2);
        p.disconnect(c1);
        await sleep(5);
        check('a second open tab keeps the person online when the first closes', !w.events.some(([e, d]) => e === 'presence' && d.online === false) && p.stats().onlineUsers >= 1);
        const c1b = p.connect('seller', mkHandle()); p.connect('seller', t3);
        check('more than the per-person stream cap replaces the OLDEST stream', t2.closed === 'replaced');
        check('every stream is kept alive with pings', (await sleep(45), t3.pings >= 1));
        await sleep(60);
        check('streams end themselves after their maximum age so the client re-authenticates', t3.closed === 'reconnect');
        const t4 = mkHandle(); p.connect('seller', t4);
        const n = p.disconnectUser('seller', 'session-ended');
        check('disconnectUser ends every stream a person has', n >= 1 && t4.closed === 'session-ended');
        const live = mkHandle(); p.connect('late', live);
        const savedBefore = saved.length;
        await p.shutdown();
        check('shutdown closes every remaining stream and saves who was around', p.stats().connections === 0 && live.closed === 'shutdown' && saved.length > savedBefore && saved[saved.length - 1].ids.includes('late'));
        check('nothing can connect after shutdown', p.connect('x', mkHandle()) === null);
    }
    // ---- engine: Redis fan-out against a FAKE redis ---------------------------
    {
        const bus = new EventEmitter(); const hashes = new Map();
        const mkRedis = () => {
            const r = {
                pipeline() { const ops = []; const q = { hset: (k, f, v) => { ops.push(() => { if (!hashes.has(k)) hashes.set(k, {}); hashes.get(k)[f] = v; return [null, 1]; }); return q; }, expire: () => { ops.push(() => [null, 1]); return q; }, hgetall: (k) => { ops.push(() => [null, { ...(hashes.get(k) || {}) }]); return q; }, hdel: (k, f) => { ops.push(() => { if (hashes.get(k)) delete hashes.get(k)[f]; return [null, 1]; }); return q; }, exec: async () => ops.map((o) => o()) }; return q; },
                hdel: async (k, f) => { if (hashes.get(k)) delete hashes.get(k)[f]; },
                publish: async (ch, msg) => { setImmediate(() => bus.emit('message', ch, msg)); },
                duplicate() { const s = new EventEmitter(); s.subscribe = async () => { bus.on('message', (ch, m) => s.emit('message', ch, m)); }; s.disconnect = () => {}; return s; }
            };
            return r;
        };
        const mkNode = () => { const saved = []; return { saved, p: createPresence({ redis: mkRedis(), persist: async (ids, date) => { saved.push({ ids, date }); }, options: { graceMs: 30, heartbeatMs: 1000 }, log: quiet }) }; };
        const A = mkNode(), B = mkNode();
        const w = mkHandle(); const wc = B.p.connect('viewer', w); await B.p.watch(wc, [['conversation:c', 'carol']]);
        const cc = A.p.connect('carol', mkHandle());
        await sleep(20);
        check('a person connecting on another instance shows online to a viewer here', w.events.some(([e, d]) => e === 'presence' && d.online === true));
        check('describe on the OTHER instance sees them online via Redis', (await B.p.describe([{ id: 'carol' }])).get('carol').online === true);
        const cc2 = B.p.connect('carol', mkHandle());
        A.p.disconnect(cc);
        await sleep(80);
        check('going offline on one instance does not announce offline while another still holds them', !w.events.some(([e, d]) => e === 'presence' && d.online === false));
        B.p.disconnect(cc2);
        await sleep(80);
        check('offline is announced once no instance holds them', w.events.some(([e, d]) => e === 'presence' && d.online === false));
        await A.p.shutdown(); await B.p.shutdown();
    }
    // ---- route: authorisation of watch keys -------------------------------------
    const { resolveWatches } = require(path.join(SRC, 'routes', 'presence.js'));
    db.conversations = [
        { id: 'c1', buyerId: 'me', store: { ownerId: 'seller1' } },
        { id: 'c2', buyerId: 'other', store: { ownerId: 'me' } },
        { id: 'c3', buyerId: 'x', store: { ownerId: 'y' } }
    ];
    db.stores = [
        { slug: 'live', ownerId: 'seller9', isPublished: true, deletedAt: null, trialEndsAt: future() },
        { slug: 'expired', ownerId: 'seller8', isPublished: true, deletedAt: null, trialEndsAt: new Date(0) }
    ];
    const entries = Object.fromEntries(await resolveWatches({ id: 'me' }, ['conversation:c1', 'conversation:c2', 'conversation:c3', 'conversation:nope', 'store:live', 'store:expired', 'store:missing']));
    check('a buyer watches the seller of their own conversation', entries['conversation:c1'] === 'seller1');
    check('a seller watches the buyer of a conversation with their store', entries['conversation:c2'] === 'other');
    check('a conversation the caller is not a party to is dropped silently', !('conversation:c3' in entries) && !('conversation:nope' in entries));
    check('a live public store resolves to its owner', entries['store:live'] === 'seller9');
    check('a store outside its trial/paid window is dropped like one that does not exist', !('store:expired' in entries) && !('store:missing' in entries));

    // ---- route: the SSE stream ---------------------------------------------------
    const handlers = routeTable['POST /stream'];
    const streamHandler = handlers[handlers.length - 1];
    const mkRes = () => { const r = new EventEmitter(); Object.assign(r, { headers: {}, chunks: [], ended: false, headersSent: false, statusCode: 0, status(c) { this.statusCode = c; return this; }, set(o) { Object.assign(this.headers, o); return this; }, flushHeaders() { this.headersSent = true; }, write(c) { this.chunks.push(c); return true; }, end() { this.ended = true; } }); return r; };
    const req = { user: { id: 'me' }, body: { watch: ['conversation:c1'] }, socket: { setTimeout() {}, setNoDelay() {}, setKeepAlive() {} } };
    const res = mkRes();
    await streamHandler(req, res, (e) => { throw e; });
    const text = res.chunks.join('');
    check('the stream answers 200 as text/event-stream', res.statusCode === 200 && /^text\/event-stream/.test(res.headers['Content-Type']));
    check('the stream is no-transform (so compression() leaves it alone) and unbuffered behind nginx', /no-transform/.test(res.headers['Cache-Control']) && res.headers['X-Accel-Buffering'] === 'no');
    check('the first event is a snapshot in proper SSE framing, keyed by watch key, never by user id',
        /^event: snapshot\ndata: \{.*\}\n\n/.test(text) && text.includes('"conversation:c1"') && !text.includes('seller1'));
    check('being connected makes the caller show as online', shared.stats().onlineUsers >= 1);
    const other = mkRes();
    await streamHandler({ user: { id: 'seller1' }, body: { watch: [] }, socket: {} }, other, () => {});
    check('another person connecting is pushed to the watcher as a presence event', res.chunks.join('').includes('event: presence') && res.chunks.join('').includes('"online":true'));
    const before = res.chunks.length;
    shared.disconnectUser('me', 'session-ended');
    check('revoking a session ends the stream with an explicit reason', res.ended && res.chunks.slice(before).join('').includes('"reason":"session-ended"'));
    res.emit('close'); other.emit('close');
    await shared.shutdown();

    // ---- public one-off status ---------------------------------------------------
    const storeGet = routeTable['GET /store/:slug'][0];
    const sres = { headers: {}, body: null, set(k, v) { this.headers[k] = v; return this; }, json(b) { this.body = b; return this; } };
    let err = null;
    db.stores = [{ slug: 'live', ownerId: 's', isPublished: true, deletedAt: null, trialEndsAt: future(), owner: { id: 's', lastActiveAt: new Date('2026-09-01T00:00:00Z') } }];
    await storeGet({ params: { slug: 'live' } }, sres, (e) => { err = e; });
    check('the public store status returns { key, online, lastActiveAt } and is never cached', !err && sres.body.data.key === 'store:live' && sres.body.data.online === false && sres.headers['Cache-Control'] === 'no-store');
    await storeGet({ params: { slug: 'nope' } }, sres, (e) => { err = e; });
    check('an unknown or hidden store is a 404, not an empty status', err && err.status === 404);
    await storeGet({ params: { slug: 'bad slug!' } }, sres, (e) => { err = e; });
    check('a malformed slug is rejected before any query', err && err.status === 404);

    // ---- middleware: presence never renews a session ---------------------------------
    const m = middlewareSource.match(/const BACKGROUND_ANY_METHOD_PATH = (\/.*\/);/);
    const rx = m ? eval(m[1]) : null;
    check('presence routes (any method) are recognised as background traffic', !!rx && rx.test('/api/presence/stream') && rx.test('/api/presence/store/abc') && !rx.test('/api/presence-other') && !rx.test('/api/messages'));
    check('isBackgroundRequest consults that pattern', /BACKGROUND_ANY_METHOD_PATH\.test\(path\)/.test(middlewareSource));

    const failed = results.filter((r) => !r.ok);
    results.forEach((r) => console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok || !r.detail ? '' : `\n      ${r.detail}`}`));
    console.log(`\n${results.length - failed.length}/${results.length} presence checks passed.`);
    process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
