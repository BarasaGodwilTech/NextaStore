/**
 * WIP 114: "Continue with Google" and email verification, tested without Google, a browser or a database server.
 * Google ID tokens are made here with our OWN RSA key and a stand-in for Google's key list, so the real verifier code runs for real.
 * Run:  node scripts/google-auth-test.js
 */
'use strict';
const crypto = require('crypto');
const path = require('path');
const { createGoogleVerifier, googleSignIn, GoogleAuthError } = require(path.join(__dirname, '..', 'src', 'googleAuth.js'));
const emails = require(path.join(__dirname, '..', 'src', 'emailTemplates.js'));
const { createMemoryPrisma } = require('./lib/memory-prisma');
let passed = 0, failed = 0;
const check = (n, ok, x) => { if (ok) { passed += 1; console.log('  ok   ' + n); } else { failed += 1; console.log('  FAIL ' + n + (x ? ' -> ' + x : '')); } };
const rejects = async (name, code, fn) => { try { await fn(); check(name, false, 'did not throw'); } catch (e) { check(name, e.code === code, `got ${e.code || e.message}`); } };
const b64 = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const CLIENT = '1234567890-test.apps.googleusercontent.com';
const kp = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwkOf = (pair, kid) => ({ ...pair.publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'RS256' });
let nowMs = Date.parse('2026-10-27T10:00:00Z');
const NOW = () => nowMs;
let served = [jwkOf(kp, 'k1')], fetches = 0, fetchFails = false;
const fetchKeys = async () => { fetches += 1; if (fetchFails) throw new Error('offline'); return { keys: served, maxAgeSec: 600 }; };
const verifier = () => createGoogleVerifier({ clientIds: [CLIENT], fetchKeys, now: NOW });

function token(over = {}, { pair = kp, kid = 'k1', alg = 'RS256', header = {}, tamper = false } = {}) {
    const iat = Math.floor(nowMs / 1000);
    const payload = { iss: 'https://accounts.google.com', aud: CLIENT, sub: '10769150350006150715113', email: 'Ann.Mukasa@Gmail.com', email_verified: true, name: 'Ann Mukasa', picture: 'https://lh3.googleusercontent.com/a/x', iat, exp: iat + 3600, ...over };
    const h = b64(JSON.stringify({ alg, kid, typ: 'JWT', ...header })), p = b64(JSON.stringify(payload));
    const sig = alg === 'RS256' ? crypto.sign('RSA-SHA256', Buffer.from(`${h}.${p}`), pair.privateKey) : Buffer.from('x');
    const t = `${h}.${p}.${b64(sig)}`;
    return tamper ? `${h}.${b64(JSON.stringify({ ...payload, email: 'victim@gmail.com' }))}.${b64(sig)}` : t;
}

(async () => {
    console.log('Verifying the token');
    const v = verifier();
    const ok = await v.verify(token());
    check('a genuine token gives the person\'s Google id, lower-cased email and name', ok.sub === '10769150350006150715113' && ok.email === 'ann.mukasa@gmail.com' && ok.name === 'Ann Mukasa');
    check('Google\'s key list is fetched once and kept', fetches === 1 && (await v.verify(token()), fetches === 1));
    await rejects('a token signed by someone else\'s key is refused', 'BAD_SIGNATURE', () => verifier().verify(token({}, { pair: other })));
    await rejects('a token whose contents were changed after signing is refused', 'BAD_SIGNATURE', () => verifier().verify(token({}, { tamper: true })));
    await rejects('"alg: none" is refused before any key is looked at', 'BAD_ALG', () => verifier().verify(token({}, { alg: 'none' })));
    await rejects('"alg: HS256" (the key-confusion forgery) is refused', 'BAD_ALG', () => verifier().verify(token({}, { alg: 'HS256' })));
    await rejects('a token made for ANOTHER site\'s client id is refused', 'BAD_AUDIENCE', () => verifier().verify(token({ aud: 'someone-else.apps.googleusercontent.com' })));
    await rejects('a token from a different issuer is refused', 'BAD_ISSUER', () => verifier().verify(token({ iss: 'https://evil.example.com' })));
    check('the bare "accounts.google.com" issuer Google also uses is accepted', (await verifier().verify(token({ iss: 'accounts.google.com' }))).sub.length > 0);
    await rejects('an expired token is refused', 'EXPIRED', () => verifier().verify(token({ exp: Math.floor(nowMs / 1000) - 600 })));
    check('a token that expired seconds ago is still accepted (clock skew allowance)', (await verifier().verify(token({ exp: Math.floor(nowMs / 1000) - 20 }))).sub.length > 0);
    await rejects('a token from the future is refused', 'NOT_YET_VALID', () => verifier().verify(token({ iat: Math.floor(nowMs / 1000) + 3600 })));
    await rejects('an email Google has NOT verified is refused', 'EMAIL_UNVERIFIED', () => verifier().verify(token({ email_verified: false })));
    check('Google\'s string "true" for email_verified is understood', (await verifier().verify(token({ email_verified: 'true' }))).sub.length > 0);
    await rejects('a token with no email is refused', 'NO_EMAIL', () => verifier().verify(token({ email: undefined })));
    await rejects('garbage is refused cleanly', 'MALFORMED', () => verifier().verify('not.a.jwt'));
    await rejects('a non-string is refused cleanly', 'MALFORMED', () => verifier().verify({ a: 1 }));
    await rejects('an oversized token is refused', 'MALFORMED', () => verifier().verify('a'.repeat(9000)));
    await rejects('with no client id configured Google sign-in says it is not set up', 'NOT_CONFIGURED', () => createGoogleVerifier({ clientIds: [], fetchKeys }).verify(token()));
    check('a configured verifier reports itself configured, an empty one does not', verifier().configured === true && createGoogleVerifier({ clientIds: [] }).configured === false);

    console.log('\nGoogle\'s keys');
    served = [jwkOf(kp, 'k1')]; fetches = 0;
    const rot = verifier(); await rot.verify(token());
    served = [jwkOf(kp, 'k2')];
    nowMs += 2 * 60 * 1000;                                          // past the refetch cool-down
    check('a rotated key (new id) is picked up with one fresh look', (await rot.verify(token({}, { kid: 'k2' }))).sub.length > 0 && fetches === 2);
    fetches = 0; const spam = verifier(); await spam.verify(token({}, { kid: 'k2' }));
    for (let i = 0; i < 5; i++) await spam.verify(token({}, { kid: `nope${i}` })).catch(() => {});
    check('random key ids cannot make us hammer Google (at most one extra fetch per minute)', fetches <= 2, String(fetches));
    fetchFails = true; nowMs += 3 * 3600 * 1000;
    await rejects('if Google cannot be reached the person is told to try again or use email (503, not a crash)', 'CERTS_UNAVAILABLE', () => verifier().verify(token()));
    fetchFails = false; served = [jwkOf(kp, 'k1')];

    console.log('\nSigning in, linking and creating');
    const prisma = createMemoryPrisma(() => new Date(nowMs));
    const db = prisma._db; db.verificationToken = db.verificationToken || [];
    // the in-memory database has no email-link table: a tiny stand-in with the one call the code makes
    prisma.verificationToken = { updateMany: async ({ where, data }) => { let count = 0; for (const t of db.verificationToken) if (t.userId === where.userId && (where.usedAt === null ? t.usedAt === null : true)) { Object.assign(t, data); count += 1; } return { count }; } };
    const createdWith = []; const baseCreate = prisma.user.create.bind(prisma.user);
    prisma.user.create = async (a) => { createdWith.push(a.data); return baseCreate({ ...a, data: Object.fromEntries(Object.entries(a.data).filter(([k]) => k !== 'store')) }); };
    let signups = [];
    const apiError = (message, status = 400, code) => Object.assign(new Error(message), { status, code });
    const deps = { prisma, verifier: verifier(), apiError, hashRandomPassword: async () => 'RANDOM-' + crypto.randomBytes(8).toString('hex'), starterStore: async (name, email) => ({ name: `${name}'s store`, slug: `s-${signups.length}`, email }), signToken: (u, r) => `tok-${u.id}-${r}`, afterSignup: (u, i, seller) => signups.push({ id: u.id, seller, ref: i.referralCode }) };

    const brand = await googleSignIn(deps, { credential: token(), accountType: 'buyer', referralCode: 'CIRCLE-AB12C' });
    check('a new person is created: verified at once, a buyer, with a password nobody knows, and no store', brand.isNew && brand.user.emailVerifiedAt && brand.user.role === 'buyer' && /^RANDOM-/.test(brand.user.passwordHash) && !createdWith[0].store);
    check('the Circle / Crew hook is told about the new account, with the invite code', signups.length === 1 && signups[0].ref === 'CIRCLE-AB12C');
    check('the account stores the Google id', brand.user.googleId === '10769150350006150715113' && brand.user.email === 'ann.mukasa@gmail.com');
    const again = await googleSignIn(deps, { credential: token(), accountType: 'seller', rememberMe: true });
    check('the same Google account again signs in to the SAME account (accountType is ignored once the account exists)', !again.isNew && again.user.id === brand.user.id && again.user.role === 'buyer' && again.token.endsWith('-true') && db.user.length === 1);

    const seller = await googleSignIn(deps, { credential: token({ sub: 'g-seller', email: 'shop@gmail.com', name: 'Shop Owner' }), accountType: 'seller' });
    check('a new person who chose "open a shop" gets a seller account created together with a starter store', seller.isNew && seller.user.role === 'seller' && createdWith.at(-1).store && createdWith.at(-1).store.create.name === "Shop Owner's store" && signups.at(-1).seller === true);

    // an existing, verified password account with the same email
    db.user.push({ id: 'u_old', name: 'Ben', email: 'ben@gmail.com', passwordHash: 'bcrypt-bens', emailVerifiedAt: new Date(), role: 'buyer', accountStatus: 'active', tokenVersion: 0, googleId: null });
    const link = await googleSignIn(deps, { credential: token({ sub: 'g-ben', email: 'ben@gmail.com', name: 'Ben' }) });
    check('Ben, who verified his email earlier, is linked: same account, his password still works, sessions untouched', link.linked && !link.passwordReset && link.user.id === 'u_old' && link.user.passwordHash === 'bcrypt-bens' && link.user.tokenVersion === 0 && link.user.googleId === 'g-ben');

    // pre-hijack: a squatter registered the victim's email, never verified it
    db.user.push({ id: 'u_squat', name: 'Squatter', email: 'victim@gmail.com', passwordHash: 'bcrypt-squatter-knows', emailVerifiedAt: null, role: 'buyer', accountStatus: 'active', tokenVersion: 4, googleId: null });
    db.verificationToken.push({ id: 'vt1', userId: 'u_squat', type: 'email_verify', usedAt: null });
    const real = await googleSignIn(deps, { credential: token({ sub: 'g-victim', email: 'victim@gmail.com', name: 'Real Victim' }) });
    check('PRE-HIJACK: when the real owner arrives via Google, the squatter\'s password is thrown away', real.linked && real.passwordReset && real.user.passwordHash !== 'bcrypt-squatter-knows' && /^RANDOM-/.test(real.user.passwordHash));
    check('and every session the squatter had is signed out (token version bumped), and the account is now verified', real.user.tokenVersion === 5 && !!real.user.emailVerifiedAt);
    check('and any unused email links the squatter requested are cancelled', db.verificationToken.find((t) => t.id === 'vt1').usedAt !== null);

    db.user.push({ id: 'u_sus', name: 'Sus', email: 'sus@gmail.com', passwordHash: 'x', emailVerifiedAt: new Date(), role: 'buyer', accountStatus: 'suspended', tokenVersion: 0, googleId: null });
    await rejects('a suspended account cannot get in through Google either (by email)', 'ACCOUNT_SUSPENDED', () => googleSignIn(deps, { credential: token({ sub: 'g-sus', email: 'sus@gmail.com' }) }));
    db.user.push({ id: 'u_sus2', name: 'Sus2', email: 'sus2@gmail.com', passwordHash: 'x', emailVerifiedAt: new Date(), role: 'buyer', accountStatus: 'suspended', tokenVersion: 0, googleId: 'g-sus2' });
    await rejects('nor by Google id', 'ACCOUNT_SUSPENDED', () => googleSignIn(deps, { credential: token({ sub: 'g-sus2', email: 'sus2@gmail.com' }) }));
    db.user.push({ id: 'u_two', name: 'Two', email: 'two@gmail.com', passwordHash: 'x', emailVerifiedAt: new Date(), role: 'buyer', accountStatus: 'active', tokenVersion: 0, googleId: 'g-first' });
    await rejects('an email already linked to a DIFFERENT Google account is refused', 'GOOGLE_MISMATCH', () => googleSignIn(deps, { credential: token({ sub: 'g-second', email: 'two@gmail.com' }) }));
    check('every refusal left the database as it was (no half-linked accounts)', db.user.find((u) => u.id === 'u_two').googleId === 'g-first');

    // two first sign-ins at the same instant
    let raced = false;
    prisma.user.create = async (a) => { if (!raced) { raced = true; await baseCreate({ ...a, data: Object.fromEntries(Object.entries(a.data).filter(([k]) => k !== 'store')) }); throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }); } return baseCreate(a); };
    const race = await googleSignIn(deps, { credential: token({ sub: 'g-race', email: 'race@gmail.com', name: 'Race' }) });
    check('two first sign-ins at the same moment end as ONE account, not an error', !race.isNew && race.user.email === 'race@gmail.com' && db.user.filter((u) => u.email === 'race@gmail.com').length === 1);
    prisma.user.create = baseCreate;

    console.log('\nEmails');
    const m = emails.verifyEmail({ name: 'Ann <b>Mukasa</b>', link: 'https://nextastores.com/verify-email?token=abc&x=1' });
    check('the verification email has a subject, a plain-text part and an HTML part', m.subject && m.text.includes('https://nextastores.com/verify-email?token=abc&x=1') && /^<!doctype html>/.test(m.html));
    check('a name with HTML in it cannot inject markup', !m.html.includes('<b>Mukasa</b>') && m.html.includes('Welcome, Ann'));
    check('the link is escaped in the HTML (an ampersand stays valid) and is shown as text too', m.html.includes('token=abc&amp;x=1') && (m.html.match(/token=abc&amp;x=1/g) || []).length >= 2);
    check('it says how long the link lasts and that it can be ignored if the person did not sign up', /24 hours/.test(m.text) && /ignore/.test(m.text));
    const r = emails.resetPassword({ name: 'Ben', link: 'https://x/forgot-password?token=t' });
    check('the reset email says the password has not changed unless they act', /has not changed/.test(r.text) && /1 hour/.test(r.text) && r.html.includes('Choose a new password'));

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
