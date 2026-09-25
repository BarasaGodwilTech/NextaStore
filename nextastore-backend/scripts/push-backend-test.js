#!/usr/bin/env node
'use strict';
/*
 * Runs the REAL src/push.js and src/routes/push.js with express, Prisma,
 * web-push and the config stubbed out, so it needs no node_modules, database
 * or network:
 *
 *   npm run test:push
 *
 * What this proves: sending results and cleanup rules in src/push.js, and the
 * behaviour of POST /api/push/test (who it sends to, the throttle, the status
 * codes). What it does NOT prove: that Express mounts the router, that the
 * real Prisma queries run against Postgres, or that a push service accepts the
 * message. For those, hit the running server (see the README's "Web Push"
 * section).
 */
const path = require('path');
const Module = require('module');

const SRC = path.resolve(__dirname, '..', 'src');
const results = [];
function check(name, ok, detail = '') { results.push({ name, ok: !!ok, detail }); }

// ---- stubs -------------------------------------------------------------------
const db = { subs: [], failNext: null, users: { u1: { name: 'Amina Nakato' }, u2: { name: 'Peter Okello' } }, userLookupFails: false };
let nextId = 1;
const addSub = (userId, endpoint) => { const s = { id: `s${nextId++}`, userId, endpoint, p256dh: `p-${endpoint}`, auth: `a-${endpoint}` }; db.subs.push(s); return s; };

const fakePrisma = {
    user: {
        findUnique: async ({ where }) => { if (db.userLookupFails) throw new Error('user lookup down'); return db.users[where.id] || null; }
    },
    pushSubscription: {
        findMany: async ({ where }) => { if (db.failNext) throw db.failNext; return db.subs.filter((s) => s.userId === where.userId).map((s) => ({ ...s })); },
        delete: async ({ where }) => { const i = db.subs.findIndex((s) => s.id === where.id); if (i < 0) throw new Error('not found'); db.subs.splice(i, 1); },
        deleteMany: async ({ where }) => {
            if (db.failNext) throw db.failNext;
            const before = db.subs.length;
            db.subs = db.subs.filter((s) => !Object.entries(where).every(([k, v]) => s[k] === v));
            return { count: before - db.subs.length };
        }
    }
};

const pushed = []; // every web-push call: { endpoint, payload, options }
let pushBehaviour = () => undefined; // (endpoint) => throws / resolves
const fakeWebpush = {
    setVapidDetails: () => {},
    sendNotification: async (sub, payload, options) => {
        pushed.push({ endpoint: sub.endpoint, keys: sub.keys, payload: JSON.parse(payload), options });
        return pushBehaviour(sub.endpoint);
    }
};

const fakeConfig = { pushEnabled: true, vapid: { subject: 'mailto:t@t.test', publicKey: 'pub', privateKey: 'priv' } };

function apiError(message, status = 400, code = null) { const e = new Error(message); e.status = status; if (code) e.code = code; return e; }

const routeTable = {};
const fakeExpress = {
    Router: () => {
        const r = {};
        for (const verb of ['get', 'post']) r[verb] = (p, ...handlers) => { routeTable[`${verb.toUpperCase()} ${p}`] = handlers; };
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
        if (/(^|\/)utils$/.test(request)) return { apiError };
        if (/(^|\/)middleware$/.test(request)) return { requireAuth: (req, res, next) => next() };
        if (/(^|\/)validation$/.test(request)) return { validateBody: () => (req, res, next) => next(), pushSubscribeSchema: {}, pushUnsubscribeSchema: {} };
    }
    return origLoad.apply(this, arguments);
};

const { sendPushToUser, removeAllSubscriptionsForUser, PUSH_TTL_SECONDS } = require(path.join(SRC, 'push.js'));
require(path.join(SRC, 'routes', 'push.js'));

// ---- tiny req/res harness for the route handlers -------------------------------
async function call(routeKey, { userId, body = {} } = {}) {
    const handlers = routeTable[routeKey];
    if (!handlers) throw new Error(`route ${routeKey} not registered`);
    const res = { statusCode: 200, headers: {}, body: null, set(k, v) { this.headers[k] = v; return this; }, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    let error = null;
    const req = { user: { id: userId }, body };
    for (const h of handlers) {
        let advanced = false;
        await h(req, res, (err) => { advanced = true; if (err) error = err; });
        if (error || !advanced) break;
    }
    return { status: error ? (error.status || 500) : res.statusCode, error, headers: res.headers, body: res.body };
}

function reset() {
    db.subs = []; db.failNext = null; db.userLookupFails = false; pushed.length = 0; pushBehaviour = () => undefined; fakeConfig.pushEnabled = true;
}
const httpError = (statusCode) => Object.assign(new Error(`push service said ${statusCode}`), { statusCode });

(async () => {
    const realNow = Date.now;
    const realConsoleError = console.error;
    console.error = () => {}; // sendPushToUser logs failures on purpose; keep test output readable

    // ------------------------------------------------------------ sendPushToUser
    reset();
    addSub('u1', 'https://push.example/a'); addSub('u1', 'https://push.example/b'); addSub('u2', 'https://push.example/other');
    let r = await sendPushToUser('u1', { type: 'new_order', title: 'New order', body: 'Order #5', link: 'dashboard.html#orders' });
    check('sends to every device the person has, and only theirs',
        r.devices === 2 && r.sent === 2 && pushed.map((p) => p.endpoint).sort().join() === 'https://push.example/a,https://push.example/b');
    check('reports { devices, sent, failed, removed }', r.failed === 0 && r.removed === 0);
    check('payload is exactly { type, title, body, link, account }',
        JSON.stringify(Object.keys(pushed[0].payload)) === JSON.stringify(['type', 'title', 'body', 'link', 'account']) && pushed[0].payload.link === 'dashboard.html#orders');
    check('payload names the account it is for, so a shared device can tell whose push it is',
        pushed.every((p) => p.payload.account === 'Amina Nakato'));
    check('each send carries that device\'s own keys', pushed.every((p) => p.keys.p256dh === `p-${p.endpoint}` && p.keys.auth === `a-${p.endpoint}`));
    check('messages expire after a day instead of web-push\'s 4-week default', PUSH_TTL_SECONDS === 86400 && pushed.every((p) => p.options && p.options.TTL === 86400));

    reset();
    db.userLookupFails = true; addSub('u1', 'https://push.example/a');
    r = await sendPushToUser('u1', { title: 'Hi' });
    check('a failed name lookup still sends the push (just without an account name)',
        r.sent === 1 && pushed[0].payload.account === '');
    db.userLookupFails = false;
    reset(); db.users.u1 = { name: '  Nakato   Grace Namukasa Kizza-Mugerwa Jr  ' }; addSub('u1', 'https://push.example/a');
    await sendPushToUser('u1', { title: 'Hi' });
    check('a long name is whitespace-collapsed and capped so it cannot crowd out the message',
        pushed[0].payload.account.length <= 32 && pushed[0].payload.account.startsWith('Nakato Grace Namukasa') && pushed[0].payload.account.endsWith('\u2026'), pushed[0].payload.account);
    db.users.u1 = { name: 'Amina Nakato' };

    reset();
    addSub('u1', 'https://push.example/gone'); addSub('u1', 'https://push.example/moved'); addSub('u1', 'https://push.example/flaky'); addSub('u1', 'https://push.example/ok');
    pushBehaviour = (endpoint) => {
        if (endpoint.endsWith('/gone')) throw httpError(410);
        if (endpoint.endsWith('/moved')) throw httpError(404);
        if (endpoint.endsWith('/flaky')) throw httpError(503);
    };
    r = await sendPushToUser('u1', { title: 'Hi' });
    check('410 and 404 remove the dead device; 503 keeps it for next time',
        db.subs.map((s) => s.endpoint.split('/').pop()).sort().join() === 'flaky,ok', db.subs.map((s) => s.endpoint).join());
    check('counts sent / failed / removed correctly', r.devices === 4 && r.sent === 1 && r.failed === 3 && r.removed === 2, JSON.stringify(r));

    reset(); addSub('u1', 'https://push.example/a');
    fakeConfig.pushEnabled = false;
    r = await sendPushToUser('u1', { title: 'Hi' });
    check('push disabled (no VAPID keys): sends nothing and touches nothing', pushed.length === 0 && r.devices === 0 && r.sent === 0);
    fakeConfig.pushEnabled = true;
    r = await sendPushToUser('u1', { body: 'no title' });
    check('no title: sends nothing', pushed.length === 0 && r.sent === 0);
    r = await sendPushToUser('nobody', { title: 'Hi' });
    check('a person with no devices: resolves with zero devices', r.devices === 0 && r.sent === 0 && pushed.length === 0);

    reset(); db.failNext = new Error('database down');
    let threw = false;
    try { r = await sendPushToUser('u1', { title: 'Hi' }); } catch (e) { threw = true; }
    check('a database failure never throws out of sendPushToUser (fire-and-forget callers rely on it)', !threw && r.sent === 0);

    // ------------------------------------------------ removeAllSubscriptionsForUser
    reset();
    addSub('u1', 'https://push.example/a'); addSub('u1', 'https://push.example/b'); addSub('u2', 'https://push.example/c');
    const removed = await removeAllSubscriptionsForUser('u1');
    check('removeAll deletes every device of that person and returns the count', removed === 2);
    check('removeAll leaves other people\'s devices alone', db.subs.length === 1 && db.subs[0].userId === 'u2');
    db.failNext = new Error('database down');
    threw = false; let n;
    try { n = await removeAllSubscriptionsForUser('u2'); } catch (e) { threw = true; }
    check('removeAll never throws and reports 0 on a database failure', !threw && n === 0);

    // ------------------------------------------------------------- POST /test
    let clock = 1_000_000;
    Date.now = () => clock;

    reset();
    fakeConfig.pushEnabled = false;
    let res = await call('POST /test', { userId: 'u1' });
    check('/test: 503 when the server has no VAPID keys', res.status === 503 && /not set up/i.test(res.error.message));
    fakeConfig.pushEnabled = true;

    res = await call('POST /test', { userId: 'u1' });
    check('/test: 409 when the person has no registered device', res.status === 409 && pushed.length === 0);

    addSub('u1', 'https://push.example/phone'); addSub('u1', 'https://push.example/laptop'); addSub('u2', 'https://push.example/strangers-phone');
    res = await call('POST /test', { userId: 'u1', body: { userId: 'u2', endpoint: 'https://push.example/strangers-phone' } });
    check('/test: succeeds and reports how many devices it reached', res.status === 200 && res.body.data.devices === 2 && res.body.data.sent === 2 && res.body.data.failed === 0);
    check('/test: sends only to the caller\'s own devices, whatever the request body says',
        pushed.length === 2 && pushed.every((p) => p.endpoint !== 'https://push.example/strangers-phone'));
    check('/test: the notification is a plain "test" with a link home', pushed[0].payload.type === 'test' && pushed[0].payload.link === '/' && !!pushed[0].payload.title);

    pushed.length = 0;
    res = await call('POST /test', { userId: 'u1' });
    check('/test: a second tap right away is refused with 429', res.status === 429 && pushed.length === 0);
    check('/test: ...with a Retry-After header the page can show', Number(res.headers['Retry-After']) > 0 && Number(res.headers['Retry-After']) <= 30, JSON.stringify(res.headers));

    res = await call('POST /test', { userId: 'u2' });
    check('/test: one person\'s cooldown does not block another', res.status === 200 && pushed.length === 1 && pushed[0].endpoint === 'https://push.example/strangers-phone');

    pushed.length = 0; clock += 29_000;
    res = await call('POST /test', { userId: 'u1' });
    check('/test: still refused just inside the 30-second window', res.status === 429);
    clock += 2_000;
    res = await call('POST /test', { userId: 'u1' });
    check('/test: allowed again once the window has passed', res.status === 200 && pushed.length === 2);

    // A test that never reached any device must not lock the person out.
    reset(); addSub('u3', 'https://push.example/dead');
    pushBehaviour = () => { throw httpError(503); };
    res = await call('POST /test', { userId: 'u3' });
    check('/test: when every send fails it says so honestly (200 with sent: 0)', res.status === 200 && res.body.data.sent === 0 && res.body.data.failed === 1);
    pushBehaviour = () => undefined; pushed.length = 0;
    res = await call('POST /test', { userId: 'u3' });
    check('/test: ...and a failed attempt does not start the cooldown, so retrying works', res.status === 200 && res.body.data.sent === 1);

    // Dead endpoint (410) gets cleaned up during a test too.
    reset(); addSub('u4', 'https://push.example/stale');
    pushBehaviour = () => { throw httpError(410); };
    res = await call('POST /test', { userId: 'u4' });
    check('/test: an expired device is reported as removed and deleted', res.body.data.removed === 1 && db.subs.length === 0);

    Date.now = realNow;
    console.error = realConsoleError;

    let failed = 0;
    for (const c of results) {
        console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok || !c.detail ? '' : `\n        -> ${c.detail}`}`);
        if (!c.ok) failed += 1;
    }
    console.log(`\n${results.length - failed}/${results.length} push backend checks passed.`);
    process.exitCode = failed ? 1 : 0;
})().catch((err) => { console.error(err); process.exitCode = 1; });
