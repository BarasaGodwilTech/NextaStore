#!/usr/bin/env node
'use strict';
/*
 * Proves password hashing no longer freezes the server, and that the real
 * signup / login / reset-password / change-password handlers still behave:
 *
 *   npm run test:password
 *
 * Runs the REAL src/password.js (worker threads), the REAL bcryptjs and the
 * REAL POST /signup, /login, /reset-password (routes/auth.js) and PUT /me
 * (routes/user.js) handlers. Prisma, Express and the other services are stubbed
 * (no database, no network).
 * Does NOT prove: real Express routing, Postgres, or behaviour on your host
 * (a hosting plan that forbids threads would use the in-thread fallback, which
 * is tested here but is not non-blocking).
 */
const path = require('path');
const Module = require('module');
const bcrypt = require('bcryptjs');
const SRC = path.resolve(__dirname, '..', 'src');
const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail });

// ---- stubs -----------------------------------------------------------------
const users = new Map();
let created = null, updated = null, pushRemoved = 0;
const fakePrisma = {
  user: {
    findUnique: async ({ where }) => users.get(where.email) || null,
    create: async ({ data }) => { created = { id: 'u-new', tokenVersion: 0, accountStatus: 'active', ...data }; return created; },
    update: async ({ where, data }) => { updated = { id: where.id, data }; return { id: where.id, name: 'N', email: 'e@x.com', role: 'buyer', ...data }; }
  },
  store: { findFirst: async () => null, findUnique: async () => null }
};
const routeTable = {};
const fakeExpress = { Router: () => { const r = {}; for (const v of ['get', 'post', 'put', 'patch', 'delete']) r[v] = (p, ...h) => { routeTable[`${v.toUpperCase()} ${p}`] = h; }; return r; } };
const passthrough = (q, r, n) => n();
const origLoad = Module._load;
Module._load = function (request, parent) {
  const from = parent && parent.filename ? parent.filename : '';
  if (request === 'express') return fakeExpress;
  if (request === 'express-rate-limit') return () => passthrough;
  if (request === '@prisma/client') return { Prisma: {}, PrismaClient: function () { return fakePrisma; } };
  if (request === 'jsonwebtoken') return { verify() { throw new Error('x'); }, sign() { return 't'; } };
  if (from.startsWith(SRC)) {
    if (/(^|\/)prisma$/.test(request)) return fakePrisma;
    if (/(^|\/)config$/.test(request)) return { isProd: false, jwtSecret: 'x', frontendUrl: 'http://x' };
    if (/(^|\/)verification$/.test(request)) return { issueToken: async () => 'tok', redeemToken: async () => 'u-reset' };
    if (/(^|\/)mailer$/.test(request)) return { sendMail: async () => {} };
    if (/(^|\/)cache$/.test(request)) return { isRedisEnabled: () => false };
    if (/(^|\/)push$/.test(request)) return { sendPushToUser: async () => {}, removeAllSubscriptionsForUser: async () => { pushRemoved++; } };
    if (/(^|\/)presence$/.test(request)) return { disconnectUser() {} };
    if (/(^|\/)validation$/.test(request)) return new Proxy({ validateBody: () => passthrough }, { get: (t, k) => (k in t ? t[k] : {}) });
    if (/(^|\/)middleware$/.test(request) && /routes/.test(from)) return { requireAuth: passthrough, signSessionToken: () => 'session-token' };
  }
  return origLoad.apply(this, arguments);
};
const passwords = require(path.join(SRC, 'password.js'));
require(path.join(SRC, 'routes', 'auth.js'));
require(path.join(SRC, 'routes', 'user.js'));
Module._load = origLoad;

const handlerOf = (key) => { const h = routeTable[key]; return h[h.length - 1]; };
const call = async (key, req) => {
  const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  let err = null;
  await handlerOf(key)({ body: {}, ...req }, res, (e) => { err = e; });
  return { res, err };
};

// Counts how many event-loop turns other work gets while `fn` runs, and the
// longest single stretch the loop was held. A blocked loop gets ~0 turns.
async function loopWhile(fn) {
  let turns = 0, longest = 0, last = process.hrtime.bigint(), stop = false;
  const spin = () => { const n = process.hrtime.bigint(); longest = Math.max(longest, Number(n - last) / 1e6); last = n; turns++; if (!stop) setImmediate(spin); };
  setImmediate(spin);
  await new Promise((r) => setImmediate(r));
  turns = 0; longest = 0; last = process.hrtime.bigint();
  const t0 = Date.now();
  await fn();
  stop = true;
  const total = Date.now() - t0;
  await new Promise((r) => setImmediate(r));
  return { turns, longest, total };
}

(async () => {
  // ---- the module itself ---------------------------------------------------
  const h1 = await passwords.hash('correct horse');
  check('hash() returns a bcrypt string at cost 10', /^\$2[aby]\$10\$.{53}$/.test(h1), h1);
  check('a hash from the worker verifies with plain bcryptjs (same format)', bcrypt.compareSync('correct horse', h1));
  const legacy = bcrypt.hashSync('old-password', 10); // what is already in the database
  check('compare() accepts a hash made the old way', (await passwords.compare('old-password', legacy)) === true);
  check('compare() rejects a wrong password', (await passwords.compare('nope', legacy)) === false);
  check('two hashes of one password differ (random salt)', h1 !== (await passwords.hash('correct horse')));

  // ---- does it stay off the main thread? -----------------------------------
  await passwords.compare('warm', legacy); // spawn workers before measuring
  const syncRun = await loopWhile(async () => { bcrypt.compareSync('pw', legacy); });
  const asyncRun = await loopWhile(() => bcrypt.compare('pw', legacy));
  const workerRun = await loopWhile(() => passwords.compare('pw', legacy));
  console.log(`  sync bcryptjs   : held the loop ${syncRun.longest.toFixed(0)}ms, ${syncRun.turns} turns, total ${syncRun.total}ms`);
  console.log(`  bcryptjs async  : held the loop ${asyncRun.longest.toFixed(0)}ms, ${asyncRun.turns} turns, total ${asyncRun.total}ms`);
  console.log(`  worker (new)    : held the loop ${workerRun.longest.toFixed(0)}ms, ${workerRun.turns} turns, total ${workerRun.total}ms`);
  check('the old sync call held the loop for essentially its whole run', syncRun.longest > syncRun.total * 0.8, `${syncRun.longest.toFixed(0)}/${syncRun.total}`);
  check('bcryptjs\u2019s own async mode still holds the loop for most of one hash (why it was not enough)', asyncRun.longest > asyncRun.total * 0.6, `${asyncRun.longest}/${asyncRun.total}`);
  check('the worker gives the loop many turns while it hashes', workerRun.turns >= 20, `${workerRun.turns} turns`);
  check('the worker never holds the loop for more than 40ms (sync holds ~80ms)', workerRun.longest < 40, `${workerRun.longest.toFixed(1)}ms`);

  // Several logins at once: the server must stay responsive throughout.
  const burst = await loopWhile(() => Promise.all([1, 2, 3, 4].map(() => passwords.compare('pw', legacy))));
  check('4 simultaneous hashes still leave the loop free (longest hold < 40ms)', burst.longest < 40, `${burst.longest.toFixed(1)}ms over ${burst.total}ms`);

  // ---- no synchronous bcrypt left in a request path --------------------------
  const fs = require('fs');
  const strip = (t) => t.replace(/\/\/.*$/gm, '');
  const authSrc = strip(fs.readFileSync(path.join(SRC, 'routes', 'auth.js'), 'utf8'));
  const userSrc = strip(fs.readFileSync(path.join(SRC, 'routes', 'user.js'), 'utf8'));
  const syncCalls = (authSrc.match(/bcrypt\.(hash|compare)Sync\(/g) || []).length;
  check('auth.js has exactly one sync bcrypt call left: the boot-time dummy hash', syncCalls === 1 && /DUMMY_PASSWORD_HASH = bcrypt\.hashSync\(/.test(authSrc));
  check('user.js has no bcrypt calls at all', !/bcrypt/.test(userSrc));

  // ---- REAL route handlers ---------------------------------------------------
  users.set('a@x.com', { id: 'u1', email: 'a@x.com', name: 'A', role: 'buyer', accountStatus: 'active', passwordHash: bcrypt.hashSync('right-pass', 10), tokenVersion: 0 });
  users.set('s@x.com', { id: 'u2', email: 's@x.com', name: 'S', role: 'buyer', accountStatus: 'suspended', passwordHash: bcrypt.hashSync('right-pass', 10), tokenVersion: 0 });

  let r = await call('POST /login', { body: { email: 'a@x.com', password: 'right-pass' } });
  check('login with the right password returns a token', !r.err && r.res.body && r.res.body.token === 'session-token', JSON.stringify(r.err && r.err.message));
  r = await call('POST /login', { body: { email: 'a@x.com', password: 'wrong-pass' } });
  const wrongMsg = r.err && r.err.message;
  check('login with the wrong password is a 401', r.err && r.err.status === 401);
  r = await call('POST /login', { body: { email: 'nobody@x.com', password: 'whatever' } });
  check('login for an unknown email gives the identical 401 message', r.err && r.err.status === 401 && r.err.message === wrongMsg);
  r = await call('POST /login', { body: { email: 's@x.com', password: 'right-pass' } });
  check('a suspended account is still refused after a correct password (403)', r.err && r.err.status === 403);

  // The timing defence: an unknown email must still cost one full compare.
  // (auth.js reads passwords.compare at call time, so wrapping the export sees it.)
  let compares = 0, sawDummy = false;
  const realCompare = passwords.compare;
  passwords.compare = async (p, hsh) => { compares++; sawDummy = sawDummy || ![...users.values()].some((u) => u.passwordHash === hsh); return realCompare(p, hsh); };
  await call('POST /login', { body: { email: 'nobody@x.com', password: 'whatever' } });
  passwords.compare = realCompare;
  check('an unknown email still runs one full hash compare (no timing leak)', compares === 1 && sawDummy, `compares=${compares}`);

  r = await call('POST /signup', { body: { name: 'New Person', email: 'new@x.com', password: 'brand-new-pass', accountType: 'buyer' } });
  check('signup stores a real bcrypt hash of the password (not the password)', created && created.passwordHash !== 'brand-new-pass' && bcrypt.compareSync('brand-new-pass', created.passwordHash));
  check('signup answers 201 with a token', r.res.code === 201 && r.res.body && r.res.body.token === 'session-token');

  r = await call('POST /reset-password', { body: { token: 't', newPassword: 'reset-pass-1' } });
  check('reset-password stores a hash that verifies and bumps tokenVersion',
    !r.err && updated && updated.id === 'u-reset' && bcrypt.compareSync('reset-pass-1', updated.data.passwordHash) && updated.data.tokenVersion && updated.data.tokenVersion.increment === 1);

  const me = { id: 'u1', passwordHash: bcrypt.hashSync('current-pass', 10), avatar: null, cover: null };
  r = await call('PUT /me', { user: me, body: { newPassword: 'changed-pass-1' } });
  check('changing password without the current one is refused (401)', r.err && r.err.status === 401);
  r = await call('PUT /me', { user: me, body: { currentPassword: 'wrong', newPassword: 'changed-pass-1' } });
  check('changing password with a wrong current one is refused (401)', r.err && r.err.status === 401);
  updated = null; pushRemoved = 0;
  r = await call('PUT /me', { user: me, body: { currentPassword: 'current-pass', newPassword: 'changed-pass-1' } });
  check('changing password with the right current one stores a verifying hash', !r.err && updated && bcrypt.compareSync('changed-pass-1', updated.data.passwordHash));
  check('...ends other sessions (tokenVersion bump), drops push devices and returns a fresh token',
    updated.data.tokenVersion.increment === 1 && pushRemoved === 1 && r.res.body && r.res.body.token === 'session-token');

  // ---- fallback: a dead pool must not turn into failed logins ---------------
  await passwords.close();
  const after = await passwords.compare('right-pass', bcrypt.hashSync('right-pass', 10));
  check('after the pool is closed the next call still answers correctly', after === true);

  // ---- process lifecycle (each in a fresh process, so no test scaffolding keeps it alive) ----
  const { spawnSync } = require('child_process');
  const runChild = (code) => spawnSync(process.execPath, ['-e', code], { cwd: path.resolve(__dirname, '..'), timeout: 20000, encoding: 'utf8' });
  const lone = runChild("const p=require('./src/password');p.hash('x').then(h=>p.compare('x',h)).then(ok=>console.log('RESULT',ok));");
  check('a script that hashes and does nothing else finishes its call AND exits by itself (workers are not left holding the process open)',
    lone.status === 0 && /RESULT true/.test(lone.stdout), `status=${lone.status} signal=${lone.signal} out=${(lone.stdout || '').trim()}`);
  const idle = runChild("const p=require('./src/password');(async()=>{const h=await p.hash('a');await new Promise(r=>setTimeout(r,300));console.log('RESULT',await p.compare('a',h));})();");
  check('a pool that has gone idle wakes up and answers the next call', idle.status === 0 && /RESULT true/.test(idle.stdout), `status=${idle.status} out=${(idle.stdout || '').trim()}`);

  // ---- report ----------------------------------------------------------------
  let failed = 0;
  for (const c of results) { if (!c.ok) failed++; console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok || !c.detail ? '' : '  -> ' + c.detail}`); }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  await passwords.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
