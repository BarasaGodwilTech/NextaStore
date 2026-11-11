/**
 * WIP 114: the auth ROUTES (src/routes/auth.js) for verification email and Google, with the heavy packages stood in for
 * (Express, JWT, rate limiter, mail, zod) but the real route code, the real Google verifier and the in-memory database.
 * Run:  node scripts/auth-routes-test.js
 */
'use strict';
const crypto = require('crypto');
const path = require('path');
const Module = require('module');
const { createMemoryPrisma } = require('./lib/memory-prisma');
let passed = 0, failed = 0;
const check = (n, ok, x) => { if (ok) { passed += 1; console.log('  ok   ' + n); } else { failed += 1; console.log('  FAIL ' + n + (x ? ' -> ' + x : '')); } };
const b64 = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

let nowMs = Date.parse('2026-10-27T10:00:00Z');
const RealDate = Date;
const FakeDate = class extends RealDate { constructor(...a) { super(...(a.length ? a : [nowMs])); } static now() { return nowMs; } };
global.Date = FakeDate;

const prisma = createMemoryPrisma(() => new RealDate(nowMs));
const db = prisma._db; db.verificationToken = [];
let tokenSeq = 0;
prisma.verificationToken = {
    findFirst: async ({ where, orderBy }) => db.verificationToken.filter((t) => t.userId === where.userId && t.type === where.type).sort((a, b) => b.createdAt - a.createdAt)[0] || null,
    deleteMany: async ({ where }) => { const keep = db.verificationToken.filter((t) => !(t.userId === where.userId && t.type === where.type && t.usedAt === null)); const count = db.verificationToken.length - keep.length; db.verificationToken.length = 0; db.verificationToken.push(...keep); return { count }; },
    updateMany: async ({ where, data }) => { let count = 0; for (const t of db.verificationToken) if (t.userId === where.userId && t.usedAt === null) { Object.assign(t, data); count += 1; } return { count }; }
};
const mails = []; let mailFails = false, mailDelivers = true, mailAvailable = true, production = false;
const mailer = { sendMail: async (m) => { if (mailFails) throw new Error('smtp down'); mails.push(m); return { delivered: mailDelivers }; }, status: () => ({ configured: true, available: mailAvailable, devMode: false }) };
const stubs = {
    express: { Router: () => { const r = { routes: {} }; ['get', 'post', 'put', 'delete'].forEach((m) => { r[m] = (p, ...h) => { r.routes[`${m} ${p}`] = h; return r; }; }); return r; } },
    bcryptjs: { hashSync: () => 'dummy-hash' }, jsonwebtoken: {}, 'express-rate-limit': () => (q, s, n) => n(),
    '../prisma': prisma, '../password': { hash: async (v) => `H:${v}`, compare: async (a, b) => b === `H:${a}` }, '../cache': { isRedisEnabled: () => false },
    '../push': { removeAllSubscriptionsForUser: async () => {} }, '../presence': { disconnectUser() {} }, '../growthInstance': { hooks: { safe: { onSignup: async () => {}, onStoreCreated: async () => {} } } },
    '../middleware': { requireAuth: (q, s, n) => n(), signSessionToken: (u, r) => `jwt-${u.id}-${r}` },
    '../validation': { validateBody: () => (q, s, n) => n(), signupSchema: {}, googleSchema: {}, loginSchema: {}, forgotPasswordSchema: {}, resetPasswordSchema: {} },
    '../helpers': { publicUser: (u) => ({ id: u.id, email: u.email, role: u.role, emailVerified: !!u.emailVerifiedAt, googleLinked: !!u.googleId }), starterStoreData: (name, email, slug) => ({ name, slug, email }) },
    '../utils': { storeSlugFrom: (s) => String(s).toLowerCase().replace(/\W+/g, '-'), apiError: (message, status = 400, code, meta) => Object.assign(new Error(message), { status, code, ...(meta ? { meta } : {}) }) },
    '../mailer': mailer,
    '../verification': { issueToken: async (userId, type) => { const raw = `raw${++tokenSeq}`; for (const t of db.verificationToken) if (t.userId === userId && t.type === type) t.usedAt = t.usedAt || new FakeDate(); db.verificationToken.push({ id: raw, userId, type, usedAt: null, createdAt: new FakeDate() }); return raw; }, redeemToken: async (raw, type) => { const t = db.verificationToken.find((x) => x.id === raw && x.type === type); if (!t || t.usedAt) throw Object.assign(new Error('That link is invalid or has expired.'), { status: 400, code: 'TOKEN_INVALID' }); t.usedAt = new FakeDate(); return t.userId; } }
};
let googleIds = ['cid-1.apps.googleusercontent.com'];
const origLoad = Module._load;
Module._load = function (request, parent, ...rest) {
    if (request === '../config') return { frontendUrl: 'https://app.test', get isProd() { return production; }, emailVerificationRequiredFrom: new RealDate('2026-10-27T00:00:00Z'), get googleClientIds() { return googleIds; } };
    if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
    return origLoad.call(this, request, parent, ...rest);
};
const loadRouter = () => { delete require.cache[require.resolve(path.join(__dirname, '..', 'src', 'routes', 'auth.js'))]; return require(path.join(__dirname, '..', 'src', 'routes', 'auth.js')); };
const call = (router, key, { body = {}, user = null } = {}) => new Promise((resolve) => {
    const chain = router.routes[key]; const res = { status(c) { this.code = c; return this; }, json(b) { resolve({ code: this.code || 200, body: b }); }, setHeader() {} };
    chain[chain.length - 1]({ body, user, ip: '10.0.0.1' }, res, (err) => resolve({ error: err }));
});

// ---- Google's key list, served by a stand-in fetch
const kp = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...kp.publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
global.fetch = async () => ({ ok: true, headers: { get: () => 'public, max-age=600' }, json: async () => ({ keys: [jwk] }) });
const idToken = (over = {}) => { const iat = Math.floor(nowMs / 1000); const h = b64(JSON.stringify({ alg: 'RS256', kid: 'k1' })), p = b64(JSON.stringify({ iss: 'https://accounts.google.com', aud: googleIds[0], sub: 'g-1', email: 'amina@gmail.com', email_verified: true, name: 'Amina K', iat, exp: iat + 3600, ...over })); return `${h}.${p}.${b64(crypto.sign('RSA-SHA256', Buffer.from(`${h}.${p}`), kp.privateKey))}`; };

(async () => {
    console.log('What the sign-in pages are told');
    let router = loadRouter();
    let r = await call(router, 'get /config');
    check('with a Google client id set, the pages are given it', r.body.data.google.clientId === 'cid-1.apps.googleusercontent.com');
    googleIds = []; router = loadRouter(); r = await call(router, 'get /config');
    check('with none set, google is null and the button never appears', r.body.data.google === null);
    r = await call(router, 'post /google', { body: { credential: idToken() } });
    check('and POST /auth/google then answers "not set up" (501), with a code the page can read', r.error && r.error.status === 501 && r.error.code === 'GOOGLE_NOT_CONFIGURED');
    googleIds = ['cid-1.apps.googleusercontent.com']; router = loadRouter();

    console.log('\nSigning up with a password: the email must be confirmed before anyone gets in');
    r = await call(router, 'post /signup', { body: { name: 'Zawadi N', email: 'Zawadi@Example.com', password: 'a-long-password', accountType: 'buyer' } });
    const user = db.user.find((u) => u.email === 'zawadi@example.com');
    check('the account is created UNVERIFIED and NO session is issued', r.code === 201 && user && !user.emailVerifiedAt && r.body.verificationRequired === true && !r.body.token && !r.body.user, JSON.stringify(r.body));
    check('the answer says where the email went and that it was sent', r.body.email === 'zawadi@example.com' && r.body.emailSent === true && !r.body.devLink);
    check('a confirmation email went to the right address, with a link on the site and an HTML part', mails.length === 1 && mails[0].to === 'zawadi@example.com' && /^https:\/\/app\.test\/verify-email\?token=raw1$/m.test(mails[0].text.match(/https:\/\/app\.test\/verify-email\?token=\w+/)[0]) && /<html/.test(mails[0].html));
    r = await call(router, 'post /login', { body: { email: 'zawadi@example.com', password: 'a-long-password' } });
    check('signing in before confirming is refused (403) with a code the page acts on, and the address to resend to', r.error && r.error.status === 403 && r.error.code === 'EMAIL_NOT_VERIFIED' && r.error.meta && r.error.meta.email === 'zawadi@example.com', JSON.stringify(r.error && r.error.code));
    r = await call(router, 'post /login', { body: { email: 'zawadi@example.com', password: 'wrong-password' } });
    check('a wrong password is still just "don\'t match" (nothing about confirmation leaks without the password)', r.error && r.error.status === 401);
    r = await call(router, 'post /verify-email', { body: { token: 'raw1' } });
    check('opening the link confirms the address AND signs the person in', r.body && r.body.data.emailVerified === true && /^jwt-/.test(r.body.token) && db.user.find((u) => u.email === 'zawadi@example.com').emailVerifiedAt, JSON.stringify(r.body));
    r = await call(router, 'post /verify-email', { body: { token: 'raw1' } });
    check('the same link cannot be used twice', r.error && r.error.code === 'TOKEN_INVALID');
    r = await call(router, 'post /login', { body: { email: 'zawadi@example.com', password: 'a-long-password' } });
    check('after confirming, normal sign-in works', r.body && /^jwt-/.test(r.body.token));

    console.log('\nWho is exempt from the rule');
    db.user.push({ id: 'legacy1', name: 'Old Timer', email: 'old@example.com', passwordHash: 'H:old-password-1', role: 'seller', emailVerifiedAt: null, createdAt: new RealDate('2026-06-01T00:00:00Z'), accountStatus: 'active' });
    r = await call(router, 'post /login', { body: { email: 'old@example.com', password: 'old-password-1' } });
    check('an account from BEFORE the rule keeps working while unverified (nobody is locked out of a live shop)', r.body && /^jwt-/.test(r.body.token));

    console.log('\nWhen email is not working');
    mailAvailable = false;
    const usersBefore = db.user.length;
    r = await call(router, 'post /signup', { body: { name: 'No Mail', email: 'nomail@example.com', password: 'a-long-password', accountType: 'buyer' } });
    check('password sign-up says so up front (503, EMAIL_UNAVAILABLE) and creates NOTHING', r.error && r.error.status === 503 && r.error.code === 'EMAIL_UNAVAILABLE' && db.user.length === usersBefore);
    r = await call(router, 'get /config');
    check('the pages are told email is unavailable, so they lead with Google', r.body.data.email.available === false);
    r = await call(router, 'post /resend-verification', { body: { email: 'zawadi@example.com' } });
    check('resend also says so honestly instead of pretending', r.error && r.error.code === 'EMAIL_UNAVAILABLE');
    mailAvailable = true;
    r = await call(router, 'get /config');
    check('and when email is back, the pages are told it is available', r.body.data.email.available === true);

    mailFails = true;
    r = await call(router, 'post /signup', { body: { name: 'Baraka O', email: 'baraka@example.com', password: 'a-long-password', accountType: 'buyer' } });
    check('if one email fails to send, the account exists but the page is told emailSent:false (so it offers "resend")', r.code === 201 && r.body.emailSent === false && db.user.some((u) => u.email === 'baraka@example.com'));
    mailFails = false;
    const mailsBefore = mails.length;
    r = await call(router, 'post /resend-verification', { body: { email: 'baraka@example.com' } });
    check('resend works WITHOUT being signed in, and sends the email', r.body && mails.length === mailsBefore + 1 && mails[mails.length - 1].to === 'baraka@example.com');
    r = await call(router, 'post /resend-verification', { body: { email: 'baraka@example.com' } });
    check('asking again at once does not send a second email (no inbox flooding)', r.body && mails.length === mailsBefore + 1);
    r = await call(router, 'post /resend-verification', { body: { email: 'nobody@example.com' } });
    check('an unknown address gets the SAME answer and no email (cannot be used to find who is registered)', r.body && /on its way/.test(r.body.data.message) && mails.length === mailsBefore + 1);
    r = await call(router, 'post /resend-verification', { body: { email: 'zawadi@example.com' } });
    check('an already-confirmed address gets the same answer and no email', r.body && /on its way/.test(r.body.data.message) && mails.length === mailsBefore + 1);
    r = await call(router, 'post /resend-verification', { body: { email: 'not-an-email' } });
    check('garbage is refused as 400', r.error && r.error.status === 400);

    console.log('\nDevelopment without SMTP');
    mailDelivers = false;
    r = await call(router, 'post /signup', { body: { name: 'Dev Person', email: 'dev@example.com', password: 'a-long-password', accountType: 'buyer' } });
    check('in development the link is handed back so you can click it (and emailSent is false)', r.body && r.body.emailSent === false && /verify-email\?token=/.test(r.body.devLink || ''));
    production = true;
    r = await call(router, 'post /signup', { body: { name: 'Prod Person', email: 'prod@example.com', password: 'a-long-password', accountType: 'buyer' } });
    check('in production the link is NEVER put in the response', r.body && !r.body.devLink);
    production = false; mailDelivers = true;

    console.log('\nSigning up again over an address that never confirmed');
    const mailsB = mails.length;
    nowMs += 120 * 1000;
    r = await call(router, 'post /signup', { body: { name: 'Squatter', email: 'victim@example.com', password: 'squatter-password', accountType: 'buyer' } });
    check('someone signs up with an address they do not own: the account exists but cannot be used', r.code === 201 && db.user.find((u) => u.email === 'victim@example.com'));
    nowMs += 120 * 1000;
    r = await call(router, 'post /signup', { body: { name: 'Real Owner', email: 'victim@example.com', password: 'owners-password', accountType: 'seller' } });
    const vic = db.user.find((u) => u.email === 'victim@example.com');
    check('the REAL owner can still sign up with it: it replaces the unconfirmed one instead of being locked out', r.code === 201 && db.user.filter((u) => u.email === 'victim@example.com').length === 1 && vic.name === 'Real Owner' && vic.passwordHash === 'H:owners-password', JSON.stringify(r.error && r.error.message));
    check('...and the squatter\'s password no longer works, even after confirming', vic.passwordHash !== 'H:squatter-password');
    check('...and choosing "sell" on the second try gives them a seller account with a shop', vic.role === 'seller' && db.store.some((st) => st.ownerId === vic.id));
    const liveToken = db.verificationToken.filter((t) => t.userId === vic.id && t.usedAt === null).pop();
    r = await call(router, 'post /verify-email', { body: { token: liveToken.id } });
    check('a seller who just confirmed is told to go and set up their shop, and is signed in', r.body && r.body.needsOnboarding === true && /^jwt-/.test(r.body.token) && r.body.data.role === 'seller', JSON.stringify(r.body || r.error && r.error.message));
    db.user.find((u) => u.id === vic.id).emailVerifiedAt = null;   // put it back for the checks that follow
    r = await call(router, 'post /signup', { body: { name: 'Another', email: 'zawadi@example.com', password: 'a-long-password', accountType: 'buyer' } });
    check('a CONFIRMED address cannot be taken over this way', r.error && /already exists/.test(r.error.message));
    r = await call(router, 'post /signup', { body: { name: 'Another', email: 'old@example.com', password: 'a-long-password', accountType: 'buyer' } });
    check('an older unconfirmed account (a real, pre-rule account) cannot be taken over either', r.error && /already exists/.test(r.error.message) && db.user.find((u) => u.email === 'old@example.com').passwordHash === 'H:old-password-1');

    console.log('\nForgot-password also proves the inbox');
    db.user.push({ id: 'unc1', name: 'Unconfirmed', email: 'unc@example.com', passwordHash: 'H:first-password', role: 'buyer', emailVerifiedAt: null, createdAt: new RealDate(nowMs), accountStatus: 'active', tokenVersion: 0 });
    db.verificationToken.push({ id: 'rt1', userId: 'unc1', type: 'password_reset', usedAt: null, createdAt: new FakeDate() });
    r = await call(router, 'post /reset-password', { body: { token: 'rt1', newPassword: 'second-password-1' } });
    const unc = db.user.find((u) => u.id === 'unc1');
    check('resetting a password through the emailed link also confirms the address', r.body && unc.emailVerifiedAt && unc.passwordHash === 'H:second-password-1', JSON.stringify(r.error && r.error.message));
    r = await call(router, 'post /login', { body: { email: 'unc@example.com', password: 'second-password-1' } });
    check('and they can sign in straight away', r.body && /^jwt-/.test(r.body.token));

    console.log('\nAsking for another email (signed in, from the account page)');
    // A legacy account: it can be signed in while unverified, so it is the one that uses "send me the link again" from inside the app.
    const me = { id: 'legacy2', name: 'Late Verifier', email: 'late@example.com', passwordHash: 'H:late-password-1', role: 'buyer', emailVerifiedAt: null, createdAt: new RealDate('2026-06-01T00:00:00Z'), accountStatus: 'active', tokenVersion: 0 };
    db.user.push(me);
    const base = mails.length;
    r = await call(router, 'post /send-verification', { user: me });
    check('the first request sends an email', r.body && mails.length === base + 1 && mails[base].to === 'late@example.com');
    r = await call(router, 'post /send-verification', { user: me });
    check('a second email within a minute of the first is refused, with the seconds left', r.error && r.error.status === 429 && r.error.code === 'RESEND_TOO_SOON' && /wait \d+ seconds?/.test(r.error.message) && mails.length === base + 1, r.error && r.error.message);
    nowMs += 61 * 1000;
    r = await call(router, 'post /send-verification', { user: me });
    check('after a minute it sends again, and the answer says where it went', r.body && /late@example\.com/.test(r.body.data.message) && mails.length === base + 2);
    check('the old link is retired when a new one is issued (only one live link at a time)', db.verificationToken.filter((t) => t.userId === me.id && t.usedAt === null).length === 1);
    me.emailVerifiedAt = new FakeDate();
    r = await call(router, 'post /send-verification', { user: me });
    check('an already-verified person is told so, not sent mail', r.error && r.error.code === 'ALREADY_VERIFIED' && mails.length === base + 2);

    console.log('\nPOST /auth/google, end to end with the real verifier');
    const mailsBeforeGoogle = mails.length;
    r = await call(router, 'post /google', { body: { credential: idToken(), accountType: 'buyer' } });
    check('a genuine token creates a verified buyer and signs them in (201, isNew)', r.code === 201 && r.body.isNew === true && r.body.user.emailVerified === true && r.body.user.googleLinked === true && /^jwt-/.test(r.body.token), JSON.stringify(r).slice(0, 200));
    check('no verification email is sent to someone Google already verified', mails.length === mailsBeforeGoogle);
    r = await call(router, 'post /google', { body: { credential: idToken(), accountType: 'buyer' } });
    check('the same person again: 200, not new', r.code === 200 && r.body.isNew === false);
    r = await call(router, 'post /google', { body: { credential: idToken({ aud: 'other.apps.googleusercontent.com' }) } });
    check('a token for another site is refused with 401 and a GOOGLE_ code the page can show', r.error && r.error.status === 401 && r.error.code === 'GOOGLE_BAD_AUDIENCE');
    r = await call(router, 'post /google', { body: { credential: idToken({ email_verified: false, sub: 'g-2', email: 'x@gmail.com' }) } });
    check('a Google email Google itself has not verified is refused', r.error && r.error.code === 'GOOGLE_EMAIL_UNVERIFIED');
    const t = idToken().split('.'); r = await call(router, 'post /google', { body: { credential: `${t[0]}.${t[1]}.${b64('forged')}` } });
    check('a forged signature is refused', r.error && r.error.code === 'GOOGLE_BAD_SIGNATURE');
    global.fetch = async () => { throw new Error('offline'); }; router = loadRouter();
    r = await call(router, 'post /google', { body: { credential: idToken({ sub: 'g-9', email: 'n@gmail.com' }) } });
    check('if Google\'s keys cannot be fetched the person is asked to retry (503), not shown a crash', r.error && r.error.status === 503 && r.error.code === 'GOOGLE_CERTS_UNAVAILABLE');

    global.Date = RealDate;
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
