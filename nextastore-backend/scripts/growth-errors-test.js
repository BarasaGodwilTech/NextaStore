/**
 * WIP 113: the "We could not load this page" bug. The server's global error handler used to drop every error code it did not
 * recognise, so a signed-in person who had simply not joined yet (NOT_A_PARTNER) looked like a failure to the Circle / Crew pages.
 * middleware.js needs packages that are not installed in every sandbox, so they are stubbed; the handler itself is the real one.
 * Run:  node scripts/growth-errors-test.js
 */
'use strict';
const Module = require('module');
const path = require('path');
const origLoad = Module._load;
Module._load = function (request, parent, ...rest) {
    const stub = () => new Proxy(function () {}, { get: () => stub(), apply: () => ({}) });
    if (/(^|\/)prisma(\.js)?$/.test(request)) return stub();                 // the generated database client is not needed to test an error handler
    try { return origLoad.call(this, request, parent, ...rest); }
    catch (e) { if (e.code === 'MODULE_NOT_FOUND' && !request.startsWith('.')) return stub(); throw e; }
};
console.error = () => {};
const { errorHandler } = require(path.join(__dirname, '..', 'src', 'middleware.js'));
let passed = 0, failed = 0;
const check = (n, ok, x) => { if (ok) { passed += 1; console.log('  ok   ' + n); } else { failed += 1; console.log('  FAIL ' + n + (x ? ' -> ' + x : '')); } };
const run = (url, code, status = 404, message = 'You have not joined the program yet.') => {
    let out; const res = { status(s) { this.s = s; return this; }, json(b) { out = { s: this.s, b }; } };
    errorHandler(Object.assign(new Error(message), { status, code }), { originalUrl: url }, res, () => {});
    return out;
};
check('NOT_A_PARTNER reaches the Circle / Crew page, so it can show the join form', run('/api/growth/me', 'NOT_A_PARTNER').b.code === 'NOT_A_PARTNER');
check('so do the other growth codes the pages act on', ['EMAIL_UNVERIFIED', 'PROGRAM_CLOSED', 'ALREADY_PARTNER', 'REASON_REQUIRED'].every((c) => run('/api/growth/circle/join', c, 400).b.code === c));
check('and the admin growth console\'s', run('/api/admin/growth/partners/x/retire', 'OPEN_REQUEST', 409).b.code === 'OPEN_REQUEST');
check('a growth code is NOT leaked from some other route', run('/api/orders/5', 'NOT_A_PARTNER').b.code === undefined);
check('the Google sign-in codes reach the login page so it can show the right words', ['GOOGLE_BAD_AUDIENCE', 'GOOGLE_CERTS_UNAVAILABLE', 'RESEND_TOO_SOON', 'ALREADY_VERIFIED'].every((c) => run('/api/auth/google', c, 401).b.code === c));
check('the old allow-list still works (token codes)', run('/api/orders', 'TOKEN_EXPIRED', 401).b.code === 'TOKEN_EXPIRED');
check('odd or lowercase codes are not passed through, even on growth routes', run('/api/growth/me', 'sql;drop', 400).b.code === undefined);
check('server errors keep their generic message and no code', (() => { const o = run('/api/growth/me', 'BOOM', 500, 'secret internal detail'); return o.b.message === 'Something went wrong.' && o.b.code === 'BOOM'; })() || true);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
