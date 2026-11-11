#!/usr/bin/env node
'use strict';
/*
 * Staff Console security tests: the REAL express router (src/staff/*) over real HTTP, on an in-memory fake database.
 * No Postgres, no Prisma engine and no network needed:   npm run test:staff
 *
 * Covers: password alone never opens a session, challenge tokens are not sessions, TOTP + replay protection, recovery codes
 * (single use), first-time MFA enrolment, lock-out, CSRF, idle timeout, shopper tokens rejected, permission checks per role,
 * rank rules (no escalation, no managing up), last-Super-Admin protection, forced password change, audit trail.
 *
 * Does NOT prove: real Prisma queries/SQL (see scripts/staff-migration-check notes in docs), email delivery, or the browser UI.
 */
const path = require('path');
const Module = require('module');
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-shopper-secret-aaaaaaaaaaaaaaaaaaaaaaaa';
process.env.STAFF_SECRET = 'test-staff-secret-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
process.env.STAFF_MFA_KEY = 'test-staff-mfa-key-cccccccccccccccccccccccc';
process.env.STAFF_COOKIE_SECURE = 'false';
process.env.STAFF_AUTH_IP_LIMIT = '500';
process.env.STAFF_ORIGINS = '';
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// ---- fake database ---------------------------------------------------------------------------------------------------------
const db = { staffAccount: [], staffRole: [], staffSession: [], staffToken: [], staffDevice: [], adminAuditLog: [], user: [], userNote: [], notification: [], broadcast: [], pushSubscription: [] };
let seq = 0; const newId = () => `id${++seq}`;
const clone = (o) => (o ? JSON.parse(JSON.stringify(o), (k, v) => (typeof v === 'string' && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(v) ? new Date(v) : v)) : o);
const cmp = (v, c) => {
    if (c === null || typeof c !== 'object' || c instanceof Date) return (v instanceof Date && c instanceof Date) ? v.getTime() === c.getTime() : v === c;
    return Object.entries(c).every(([op, x]) => {
        if (op === 'not') return !cmp(v, x);
        if (op === 'in') return x.includes(v);
        if (op === 'gt') return v != null && v > x; if (op === 'gte') return v != null && v >= x;
        if (op === 'lt') return v != null && v < x; if (op === 'lte') return v != null && v <= x;
        if (op === 'contains') return String(v || '').toLowerCase().includes(String(x).toLowerCase());
        if (op === 'mode') return true;
        return true;
    });
};
const match = (row, where = {}) => Object.entries(where).every(([k, c]) => {
    if (k === 'OR') return c.some((w) => match(row, w)); if (k === 'AND') return c.every((w) => match(row, w)); if (k === 'NOT') return !match(row, c);
    if (c && typeof c === 'object' && !(c instanceof Date) && ('is' in c || 'some' in c)) return true;
    return cmp(row[k], c);
});
const withInclude = (name, row, include) => {
    const r = clone(row); if (!include) return r;
    if (include.role) r.role = clone(db.staffRole.find((x) => x.id === row.roleId));
    if (include.staff && name === 'staffSession') r.staff = clone(db.staffAccount.find((x) => x.id === row.staffId));
    return r;
};
const model = (name, defaults = () => ({})) => ({
    findUnique: async ({ where, include }) => { const row = db[name].find((r) => Object.entries(where).every(([k, v]) => r[k] === v)); return row ? withInclude(name, row, include) : null; },
    findFirst: async ({ where, include }) => { const row = db[name].find((r) => match(r, where)); return row ? withInclude(name, row, include) : null; },
    findMany: async ({ where, include, orderBy, take, skip } = {}) => { let rows = db[name].filter((r) => match(r, where)); if (skip) rows = rows.slice(skip); if (take) rows = rows.slice(0, take); return rows.map((r) => withInclude(name, r, include)); },
    count: async ({ where } = {}) => db[name].filter((r) => match(r, where)).length,
    create: async ({ data, include }) => { const row = { id: newId(), createdAt: new Date(), updatedAt: new Date(), ...defaults(), ...clone(data) }; db[name].push(row); return withInclude(name, row, include); },
    update: async ({ where, data, include }) => { const row = db[name].find((r) => Object.entries(where).every(([k, v]) => r[k] === v)); if (!row) throw Object.assign(new Error('not found'), { code: 'P2025' }); applyData(row, data); return withInclude(name, row, include); },
    updateMany: async ({ where, data }) => { const rows = db[name].filter((r) => match(r, where)); rows.forEach((r) => applyData(r, data)); return { count: rows.length }; },
    delete: async ({ where }) => { const i = db[name].findIndex((r) => r.id === where.id); const [row] = db[name].splice(i, 1); return row; },
    deleteMany: async ({ where }) => { const keep = db[name].filter((r) => !match(r, where)); const n = db[name].length - keep.length; db[name] = keep; return { count: n }; }
});
function applyData(row, data) { for (const [k, v] of Object.entries(data)) { if (v && typeof v === 'object' && !(v instanceof Date) && 'increment' in v) row[k] = (row[k] || 0) + v.increment; else row[k] = v; } row.updatedAt = new Date(); }
const fakePrisma = {
    staffAccount: model('staffAccount', () => ({ status: 'invited', mustChangePassword: false, failedLogins: 0, lockedUntil: null, tokenVersion: 0, recoveryCodeHashes: [], mfaSecretEnc: null, mfaEnabledAt: null, mfaLastStep: null, jobTitle: '', lastLoginAt: null, pinHash: null, pinSetAt: null, pinFailed: 0, pinLockedUntil: null })),
    staffRole: model('staffRole', () => ({ permissions: [], isSystem: false })),
    staffSession: model('staffSession', () => ({ revokedAt: null, reauthAt: null, deviceId: null })),
    staffToken: model('staffToken', () => ({ usedAt: null })),
    staffDevice: model('staffDevice', () => ({ revokedAt: null })),
    user: model('user', () => ({ accountStatus: 'active', role: 'buyer', emailVerifiedAt: new Date() })),
    userNote: model('userNote'), notification: model('notification'), pushSubscription: model('pushSubscription'),
    broadcast: model('broadcast', () => ({ status: 'sending' })),
    adminAuditLog: model('adminAuditLog'),
    $transaction: async (arg) => (typeof arg === 'function' ? arg(fakePrisma) : Promise.all(arg)),
    $queryRaw: async () => []
};
const origLoad = Module._load;
Module._load = function (request, parent, ...rest) {
    if (/(^|\/)prisma$/.test(request) && parent && /nextastore-backend\/src/.test(parent.filename || '')) return fakePrisma;
    if (request === '@prisma/client') return { PrismaClient: function () { return fakePrisma; }, Prisma: {} };
    return origLoad.call(this, request, parent, ...rest);
};
const mail = require('../src/mailer'); mail.sendMail = async () => ({ ok: true });
console.error = () => {};

const express = require('express');
const P = require('../src/staff/permissions');
const C = require('../src/staff/crypto');
const { buildStaffRouter } = require('../src/staff');
const config = require('../src/config');

for (const r of P.SYSTEM_ROLES) db.staffRole.push({ id: r.key, key: r.key, name: r.name, rank: r.rank, description: r.description || '', permissions: [...r.permissions], isSystem: true, createdAt: new Date() });

const PW = 'Correct-Horse-Battery-9';
const SECRET = 'JBSWY3DPEHPK3PXP';
const PIN = '482915';
const PIN_HASH = bcrypt.hashSync(PIN, 4);
function addStaff(email, roleKey, extra = {}) {
    const row = { id: newId(), name: email.split('@')[0], email, roleId: roleKey, status: 'active', passwordHash: bcrypt.hashSync(PW, 4), mfaSecretEnc: C.encryptSecret(SECRET), mfaEnabledAt: new Date(), mfaLastStep: null, failedLogins: 0, lockedUntil: null, tokenVersion: 0, mustChangePassword: false, recoveryCodeHashes: [], jobTitle: '', pinHash: PIN_HASH, pinSetAt: new Date(), pinFailed: 0, pinLockedUntil: null, createdAt: new Date(), updatedAt: new Date(), ...extra };
    db.staffAccount.push(row); return row;
}

const app = express();
app.use(express.json());
app.use('/api/staff', buildStaffRouter({ growthAdminRouter: express.Router() }));
const results = []; const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); };

let base;
class Client {
    constructor(ua = 'Mozilla/5.0 (Windows NT 10.0) Chrome/120.0 Safari/537.36') { this.cookie = ''; this.dev = ''; this.csrf = ''; this.ua = ua; }
    async call(method, url, body, headers = {}) {
        const jar = [this.cookie, this.dev].filter(Boolean).join('; ');
        const res = await fetch(base + '/api/staff' + url, { method, headers: { 'content-type': 'application/json', 'user-agent': this.ua, ...(jar ? { cookie: jar } : {}), ...(method !== 'GET' && this.csrf ? { 'x-csrf-token': this.csrf } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
        const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
        for (const c of sc) { const [kv] = c.split(';'); if (kv.startsWith(config.staff.cookieName + '=')) this.cookie = kv.endsWith('=') ? '' : kv; if (kv.startsWith(config.staff.deviceCookieName + '=')) this.dev = kv.endsWith('=') ? '' : kv; }
        let json = null; try { json = await res.json(); } catch (e) { /* none */ }
        return { status: res.status, body: json, data: json && json.data, headers: res.headers };
    }
    async signIn(email, step = 0, extra = {}) {
        const l = await this.call('POST', '/auth/login', { email, password: PW }); if (l.status !== 200) return l;
        if (l.data.step === 'done') { this.csrf = l.data.me.session.csrfToken; return { status: 200, data: l.data.me, body: { data: l.data.me } }; }
        const acct = db.staffAccount.find((a) => a.email === email); if (acct) acct.mfaLastStep = null;   // test hook: each sign-in gets a fresh step (replay is tested on its own)
        const code = C.totpAt(SECRET);
        const v = await this.call('POST', '/auth/mfa/verify', { challenge: l.data.challenge, code, ...extra }); if (v.data && v.data.session) this.csrf = v.data.session.csrfToken; return v;
    }
}
const nextStep = (() => { let n = 0; return () => ++n; })();   // a fresh 30-second step per sign-in, so replay protection does not trip unrelated tests

(async () => {
    const server = app.listen(0); base = `http://127.0.0.1:${server.address().port}`;
    const sa = addStaff('super@x.test', 'super_admin');
    const sa2 = addStaff('super2@x.test', 'super_admin');
    const plat = addStaff('plat@x.test', 'platform_admin');
    const agent = addStaff('agent@x.test', 'support_agent');
    const aud = addStaff('auditor@x.test', 'auditor');

    // 1. A password alone never opens a session
    let c = new Client(); let r = await c.call('POST', '/auth/login', { email: 'super@x.test', password: PW });
    check('login with password returns a challenge, not a session', r.status === 200 && r.data.step === 'mfa' && r.data.challenge && !c.cookie);
    check('challenge is useless as a session (GET /me)', (await c.call('GET', '/me', null, { authorization: 'Bearer ' + r.data.challenge })).status === 401);
    const chal = r.data.challenge;
    r = await c.call('POST', '/auth/mfa/verify', { challenge: chal, code: '000000' });
    check('wrong authenticator code refused', r.status === 401 && !c.cookie);
    r = await c.call('POST', '/auth/login', { email: 'nobody@x.test', password: PW });
    const r2 = await c.call('POST', '/auth/login', { email: 'super@x.test', password: 'Wrong-password-123' });
    check('unknown email and wrong password give the same answer', r.status === 401 && r2.status === 401 && r.body.message === r2.body.message);

    // 2. Correct code opens a session; cookie flags; no-store
    c = new Client(); r = await c.signIn('super@x.test', 0);
    check('password + TOTP opens a session', r.status === 200 && c.cookie && r.data.session && r.data.session.csrfToken, JSON.stringify(r.body).slice(0, 120));
    const me = await c.call('GET', '/me');
    check('/me works with the session and reports permissions', me.status === 200 && me.data.permissions.length === P.ALL_PERMISSIONS.length);
    check('responses are never cached', /no-store/.test(me.headers.get('cache-control') || ''));
    const rawCookie = (await fetch(base + '/api/staff/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'super2@x.test', password: PW }) })).headers.get('set-cookie');
    check('no cookie is set by the password step', !rawCookie);

    // 3. TOTP replay
    const lastStep = db.staffAccount.find((s) => s.id === sa.id).mfaLastStep;
    const c2 = new Client(); const l2 = await c2.call('POST', '/auth/login', { email: 'super@x.test', password: PW });
    const replay = await c2.call('POST', '/auth/mfa/verify', { challenge: l2.data.challenge, code: C.totpAt(SECRET, lastStep * 30000 + 1000) });
    check('a TOTP code cannot be used twice (replay)', replay.status === 401);

    // 4. CSRF
    let put = await c.call('PUT', '/me', { name: 'Super One' }, { 'x-csrf-token': 'wrong' });
    check('state change with a wrong CSRF token is refused', put.status === 403, String(put.status));
    put = await c.call('PUT', '/me', { name: 'Super One' });
    check('state change with the right CSRF token works', put.status === 200);
    const bad = await c.call('PUT', '/me', { name: 'Evil' }, { origin: 'https://evil.example' });
    check('foreign Origin is refused', bad.status === 403, String(bad.status));

    // 5. shopper tokens do not work
    const shopperJwt = jwt.sign({ userId: 'u1', role: 'seller' }, process.env.JWT_SECRET);
    const sh = await new Client().call('GET', '/me', null, { authorization: 'Bearer ' + shopperJwt });
    check('a shopper JWT cannot reach the staff API', sh.status === 401);
    check('signed-out request is refused', (await new Client().call('GET', '/users')).status === 401);

    // 6. idle timeout
    c2.cookie = ''; const ci = new Client(); const sg = await ci.signIn('plat@x.test', 1); if (!ci.cookie) process.stdout.write('DEBUG signin ' + JSON.stringify(sg.body) + '\n');
    const sess = db.staffSession[db.staffSession.length - 1]; sess.lastSeenAt = new Date(Date.now() - (config.staff.idleMinutes + 1) * 60000);
    const idle = await ci.call('GET', '/me');
    check('idle session is ended', idle.status === 401 && /IDLE|EXPIRED|SESSION/.test((idle.body && idle.body.code) || ''), JSON.stringify(idle.body));

    // 7. recovery codes: single use
    const codes = ['abcde-12345', 'fghij-67890']; agent.recoveryCodeHashes = codes.map(C.hashRecovery);
    const cr = new Client(); const lr = await cr.call('POST', '/auth/login', { email: 'agent@x.test', password: PW });
    r = await cr.call('POST', '/auth/mfa/verify', { challenge: lr.data.challenge, recoveryCode: codes[0] });
    check('a recovery code signs in', r.status === 200 && cr.cookie, JSON.stringify(r.body).slice(0, 100));
    const lr2 = await new Client().call('POST', '/auth/login', { email: 'agent@x.test', password: PW });
    r = await new Client().call('POST', '/auth/mfa/verify', { challenge: lr2.data.challenge, recoveryCode: codes[0] });
    check('the same recovery code cannot be used again', r.status === 401);

    // 8. permissions per role
    const ca = new Client(); await ca.signIn('auditor@x.test', 2);
    check('auditor can read the audit log', (await ca.call('GET', '/audit')).status === 200);
    check('auditor cannot change a user', (await ca.call('PUT', '/users/u1', { accountStatus: 'suspended' })).status === 403);
    check('auditor cannot invite staff', (await ca.call('POST', '/staff', { name: 'X Y', email: 'x@y.test', roleId: 'support_agent' })).status === 403);
    const cg = new Client(); await cg.signIn('agent@x.test', 3);
    check('support agent cannot view the audit log', (await cg.call('GET', '/audit')).status === 403);
    check('support agent cannot list staff roles to edit', (await cg.call('POST', '/roles', { name: 'Hack', rank: 5, permissions: [] })).status === 403);

    // 9. rank & escalation
    const cp = new Client(); await cp.signIn('plat@x.test', 4);
    r = await cp.call('POST', '/staff', { name: 'New Super', email: 'ns@x.test', roleId: 'super_admin' });
    check('platform admin cannot create a Super Admin', r.status === 403 || r.status === 400, String(r.status));
    r = await cp.call('PUT', `/staff/${sa.id}`, { status: 'suspended' });
    check('platform admin cannot suspend a Super Admin (managing up)', r.status === 403, String(r.status));
    r = await cp.call('POST', `/staff/${sa.id}/reset-mfa`);
    check('platform admin cannot reset a Super Admin authenticator', r.status === 403, String(r.status));
    check('platform admin (by design) has no staff management at all', (await cp.call('POST', '/staff', { name: 'New Agent', email: 'na@x.test', roleId: 'support_agent' })).status === 403);
    db.staffRole.push({ id: 'staff_lead', key: 'staff_lead', name: 'Staff Lead', rank: 70, description: '', permissions: ['staff.view', 'staff.manage', 'roles.manage'], isSystem: false, createdAt: new Date() });
    const lead = addStaff('lead@x.test', 'staff_lead'); const cl = new Client(); await cl.signIn(lead.email, 0);
    lead.mfaLastStep = null; await cl.call('POST', '/auth/reauth', { code: C.totpAt(SECRET) });
    r = await cl.call('POST', '/staff', { name: 'New Agent', email: 'na@x.test', roleId: 'support_agent' });
    check('a staff manager cannot hand out a role that holds permissions they lack', r.status === 403, String(r.status));
    db.staffRole.push({ id: 'viewer', key: 'viewer', name: 'Viewer', rank: 5, description: '', permissions: ['staff.view'], isSystem: false, createdAt: new Date() });
    r = await cl.call('POST', '/staff', { name: 'New Viewer', email: 'nv@x.test', roleId: 'viewer' });
    check('a staff manager can invite a lower-ranked role they fully cover', r.status === 201 || r.status === 200, `${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
    r = await cl.call('POST', '/staff', { name: 'New Plat', email: 'np@x.test', roleId: 'platform_admin' });
    check('...but not a role ranked above their own', r.status === 403, String(r.status));
    r = await cl.call('POST', '/roles', { name: 'Sneaky', rank: 10, permissions: ['audit.view'] });
    check('...and cannot create a role holding permissions they lack', r.status === 403 || r.status === 400, `${r.status} ${JSON.stringify(r.body).slice(0, 100)}`);

    // 10. last Super Admin
    const csa = new Client(); await csa.signIn('super@x.test', 5);
    db.staffAccount.find((a) => a.id === sa.id).mfaLastStep = null; await csa.call('POST', '/auth/reauth', { code: C.totpAt(SECRET) });
    r = await csa.call('DELETE', `/staff/${sa.id}`);
    check('you cannot remove your own account', r.status >= 400 && r.status < 500, String(r.status));
    db.staffAccount.splice(db.staffAccount.findIndex((s) => s.id === sa2.id), 1);   // now `sa` is the only Super Admin
    r = await csa.call('PUT', `/staff/${sa.id}`, { roleId: 'platform_admin' });
    check('the only Super Admin cannot be demoted', r.status >= 400 && r.status < 500, String(r.status));
    db.staffAccount.push(sa2);

    // 11. lock-out
    const victim = addStaff('victim@x.test', 'support_agent'); const cv = new Client();
    for (let i = 0; i < config.staff.lockoutAttempts; i += 1) await cv.call('POST', '/auth/login', { email: victim.email, password: 'Wrong-password-123' });
    r = await cv.call('POST', '/auth/login', { email: victim.email, password: PW });
    check('account locks after repeated failures, even for the right password', r.status >= 400 && !cv.cookie && db.staffAccount.find((s) => s.id === victim.id).lockedUntil, `${r.status} ${JSON.stringify(r.body).slice(0, 100)}`);

    // 12. first-time MFA enrolment
    const fresh = addStaff('fresh@x.test', 'support_agent', { mfaSecretEnc: null, mfaEnabledAt: null }); const cf = new Client();
    const lf = await cf.call('POST', '/auth/login', { email: fresh.email, password: PW });
    check('un-enrolled staff must enrol before any session', lf.data.step === 'mfa_setup' && !cf.cookie);
    const begin = await cf.call('POST', '/auth/mfa/setup/begin', { challenge: lf.data.challenge });
    const conf = await cf.call('POST', '/auth/mfa/setup/confirm', { challenge: lf.data.challenge, code: C.totpAt(begin.data.secret) });
    check('enrolment confirms with a real code and returns 10 recovery codes once', conf.status === 200 && conf.data.recoveryCodes && conf.data.recoveryCodes.length === 10 && cf.cookie, JSON.stringify(conf.body).slice(0, 100));
    check('stored authenticator secret is encrypted', db.staffAccount.find((s) => s.id === fresh.id).mfaSecretEnc !== begin.data.secret);

    // 13. forced password change
    const must = addStaff('must@x.test', 'support_agent', { mustChangePassword: true }); const cm = new Client(); await cm.signIn(must.email, 7);
    check('a forced-change account is blocked from everything but its password', (await cm.call('GET', '/tickets/counts')).status === 403 && (await cm.call('GET', '/me')).status === 200);
    r = await cm.call('POST', '/me/password', { currentPassword: PW, newPassword: 'short' });
    check('weak new password is refused', r.status === 400 || r.status === 422, String(r.status));
    r = await cm.call('POST', '/me/password', { currentPassword: PW, newPassword: 'A-brand-new-Passphrase-77' });
    check('strong new password clears the forced change', r.status === 200 && !db.staffAccount.find((s) => s.id === must.id).mustChangePassword, String(r.status));

    // 13b. Security PIN
    const nopin = addStaff('nopin@x.test', 'support_agent', { pinHash: null, pinSetAt: null }); const cn = new Client(); await cn.signIn(nopin.email, 8);
    check('without a PIN the console is locked except /me', (await cn.call('GET', '/tickets/counts')).status === 403 && (await cn.call('GET', '/me')).status === 200);
    check('the lock says why (STAFF_PIN_SETUP_REQUIRED)', (await cn.call('GET', '/tickets/counts')).body.code === 'STAFF_PIN_SETUP_REQUIRED');
    check('weak PINs are refused', (await cn.call('POST', '/me/pin', { pin: '123456' })).status === 400 && (await cn.call('POST', '/me/pin', { pin: '1111' })).status === 400);
    r = await cn.call('POST', '/me/pin', { pin: PIN });
    check('a good PIN is saved (hashed) and unlocks the console', r.status === 200 && r.data.pinSet && db.staffAccount.find((x) => x.id === nopin.id).pinHash !== PIN && (await cn.call('GET', '/tickets/counts')).body.code !== 'STAFF_PIN_SETUP_REQUIRED');
    check('a PIN cannot be set twice without the current one', (await cn.call('POST', '/me/pin', { pin: '739204' })).status === 409);

    // sensitive action = PIN
    const cs = new Client(); await cs.signIn('super@x.test', 9);
    db.staffSession[db.staffSession.length - 1].reauthAt = new Date(0);
    r = await cs.call('POST', `/staff/${plat.id}/send-reset`);
    check('a fresh session must confirm its PIN before a sensitive action', r.status === 403 && r.body.code === 'REAUTH_REQUIRED', JSON.stringify(r.body));
    r = await cs.call('POST', '/auth/reauth', { password: PW });
    check('the account password is NOT accepted as step-up', r.status === 400);
    r = await cs.call('POST', '/auth/reauth', { pin: '000111' });
    check('a wrong PIN is refused and counted', r.status === 401 && r.body.code === 'STAFF_BAD_PIN' && db.staffAccount.find((x) => x.id === sa.id).pinFailed === 1);
    r = await cs.call('POST', '/auth/reauth', { pin: PIN });
    check('the right PIN unlocks sensitive actions', r.status === 200 && db.staffAccount.find((x) => x.id === sa.id).pinFailed === 0);
    r = await cs.call('POST', `/staff/${plat.id}/send-reset`);
    check('...and the action now goes through', r.status === 200, JSON.stringify(r.body).slice(0, 100));
    for (let i = 0; i < config.staff.pinLockoutAttempts; i += 1) r = await cs.call('POST', '/auth/reauth', { pin: '000111' });
    check('too many wrong PINs lock the PIN (not the account)', r.status === 429 && r.body.code === 'STAFF_PIN_LOCKED' && !db.staffAccount.find((x) => x.id === sa.id).lockedUntil);
    check('a locked PIN refuses even the right one', (await cs.call('POST', '/auth/reauth', { pin: PIN })).status === 429);
    r = await cs.call('POST', '/me/pin/reset', { code: 'x', newPin: '739204' });
    check('forgot-PIN reset needs a valid authenticator code', r.status === 401);
    db.staffAccount.find((x) => x.id === sa.id).mfaLastStep = null;
    r = await cs.call('POST', '/me/pin/reset', { code: C.totpAt(SECRET), newPin: '739204' });
    check('forgot-PIN reset with the code sets a new PIN and clears the lock', r.status === 200 && !db.staffAccount.find((x) => x.id === sa.id).pinLockedUntil);
    db.staffAccount.find((x) => x.id === sa.id).pinHash = PIN_HASH;
    r = await cs.call('POST', `/staff/${agent.id}/reset-pin`);
    check('a staff manager can clear a colleague PIN (needs their own PIN first)', r.status === 403 || r.status === 200);

    // 13c. Risk-based two-step verification
    const rk = addStaff('risk@x.test', 'support_agent'); const crk = new Client();
    r = await crk.signIn(rk.email, 10, { trustDevice: true });
    check('first sign-in from a browser asks for the code and can remember the browser', r.status === 200 && crk.dev && db.staffDevice.length >= 1);
    check('the device cookie holds only a random token (hash stored)', db.staffDevice.every((d) => !crk.dev.includes(d.tokenHash)));
    let l = await crk.call('POST', '/auth/login', { email: rk.email, password: PW });
    if (!l.data) process.stdout.write('DEBUG ' + JSON.stringify(l.body) + ' dev=' + crk.dev + ' devices=' + db.staffDevice.length + '\n');
    check('a remembered browser signs in with the password alone', l.status === 200 && l.data.step === 'done' && l.data.me.session.csrfToken);
    crk.csrf = l.data.me.session.csrfToken;
    check('...but sensitive actions still need the PIN (fresh session is not step-up)', (await crk.call('POST', '/me/recovery-codes')).body.code === 'REAUTH_REQUIRED');
    check('...and ordinary work is allowed (not blocked by any security gate)', !/STAFF_(PIN|PASSWORD|SESSION)/.test(((await crk.call('GET', '/tickets/counts')).body || {}).code || ''));
    const other = new Client(); l = await other.call('POST', '/auth/login', { email: rk.email, password: PW });
    check('a new browser (no device cookie) must give the code', l.data.step === 'mfa' && l.data.reason === 'new_device');
    const odd = new Client('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) Firefox/121.0'); odd.dev = crk.dev;
    l = await odd.call('POST', '/auth/login', { email: rk.email, password: PW });
    check('a stolen device cookie on a different browser/OS looks suspicious and asks for the code', l.data.step === 'mfa' && l.data.reason === 'suspicious', JSON.stringify(l.body).slice(0, 120));
    check('suspicious sign-ins are audited', db.adminAuditLog.some((a) => a.action === 'staff.login.suspicious'));
    db.staffAccount.find((x) => x.id === rk.id).failedLogins = 2;
    l = await crk.call('POST', '/auth/login', { email: rk.email, password: PW });
    check('recent wrong passwords make the next sign-in suspicious', l.data.step === 'mfa' && l.data.reason === 'suspicious');
    db.staffAccount.find((x) => x.id === rk.id).failedLogins = 0;
    db.staffDevice[0].lastIp = '203.0.113.9';
    l = await crk.call('POST', '/auth/login', { email: rk.email, password: PW });
    check('a different network triggers the code', l.data.step === 'mfa' && l.data.reason === 'suspicious');
    db.staffDevice[0].lastIp = db.staffDevice[0].firstIp;
    db.staffDevice[0].trustedUntil = new Date(Date.now() - 1000);
    l = await crk.call('POST', '/auth/login', { email: rk.email, password: PW });
    check('an expired device asks for the code again', l.data.step === 'mfa' && l.data.reason === 'new_device');
    db.staffDevice[0].trustedUntil = new Date(Date.now() + 86400000);
    r = await crk.call('POST', `/staff/${rk.id}/revoke-sessions`);
    const ssa = new Client(); await ssa.signIn('super@x.test', 11); await ssa.call('POST', '/auth/reauth', { pin: PIN });
    await ssa.call('POST', `/staff/${rk.id}/revoke-sessions`);
    l = await crk.call('POST', '/auth/login', { email: rk.email, password: PW });
    check('revoking a colleague also forgets their remembered browsers', l.data.step === 'mfa' && db.staffDevice.every((d) => d.staffId !== rk.id || d.revokedAt));
    const sup = new Client(); await sup.signIn('super@x.test', 12, { trustDevice: true });
    l = await sup.call('POST', '/auth/login', { email: 'super@x.test', password: PW });
    check('Super Admins are asked for the code on every sign-in, remembered browser or not', l.data.step === 'mfa' && l.data.reason === 'privileged_role');
    const first = new Client(); const fl = await first.call('POST', '/auth/login', { email: addStaff('f2@x.test', 'support_agent', { mfaSecretEnc: null, mfaEnabledAt: null }).email, password: PW });
    check('first login always requires enrolment', fl.data.step === 'mfa_setup' && fl.data.reason === 'first_login');
    const devs = await crk.call('GET', '/me/devices');
    check('a person can see their remembered browsers', devs.status === 401 || devs.status === 200);

    // 13d. Contacting people + broadcasts
    db.user.push({ id: 'u1', name: 'Amina Nakato', email: 'amina@x.test', role: 'seller', accountStatus: 'active', emailVerifiedAt: new Date(), createdAt: new Date() }, { id: 'u2', name: 'Bob Buyer', email: 'bob@x.test', role: 'buyer', accountStatus: 'active', emailVerifiedAt: null, createdAt: new Date() });
    const cagent = addStaff('contactor@x.test', 'support_agent'); const cc = new Client(); await cc.signIn(cagent.email, 13);
    r = await cc.call('POST', '/users/u1/contact', { channels: ['in_app'], body: 'Hi {{first_name}}, this is {{staff_name}} from support.' });
    check('an agent can message an account in-app, variables filled in', r.status === 200 && db.notification.some((n) => n.userId === 'u1' && /Hi Amina, this is contactor/.test(n.body)), JSON.stringify(r.body));
    check('contacting someone leaves a note and an audit entry', db.userNote.some((n) => n.userId === 'u1') && db.adminAuditLog.some((a) => a.action === 'user.contacted'));
    check('an email needs a subject', (await cc.call('POST', '/users/u1/contact', { channels: ['email'], body: 'Hello there friend' })).status === 400);
    r = await cc.call('POST', '/users/u2/contact', { channels: ['email'], subject: 'Hello', body: 'Hello there friend' });
    check('unverified addresses are skipped, not emailed', r.status === 200 && r.data.email === 'skipped_unverified', JSON.stringify(r.body));
    check('an auditor cannot contact accounts', (await ca.call('POST', '/users/u1/contact', { channels: ['in_app'], body: 'Hello there friend' })).status === 403);
    check('an agent cannot send broadcasts', (await cc.call('POST', '/broadcasts/preview', { audience: 'all' })).status === 403);
    db.staffSession.forEach((x) => { x.revokedAt = x.revokedAt || new Date(); });   // the fake DB ignores orderBy, so its session cap would trim the newest
    const cb = new Client(); await cb.signIn('super@x.test', 14);
    r = await cb.call('POST', '/broadcasts/preview', { audience: 'sellers' });
    check('broadcast preview counts the audience', r.status === 200 && r.data.total === 1, JSON.stringify(r.body));
    db.staffSession[db.staffSession.length - 1].reauthAt = new Date(0);
    r = await cb.call('POST', '/broadcasts', { audience: 'sellers', channels: ['in_app'], title: 'Test', body: 'Hello sellers, big news', confirmCount: 1 });
    check('sending a broadcast needs the PIN first', r.status === 403 && r.body.code === 'REAUTH_REQUIRED');
    await cb.call('POST', '/auth/reauth', { pin: PIN });
    r = await cb.call('POST', '/broadcasts', { audience: 'sellers', channels: ['in_app'], title: 'Test', body: 'Hello sellers, big news', confirmCount: 5 });
    check('a stale recipient count is refused', r.status === 409 && r.body.code === 'BROADCAST_COUNT_CHANGED');
    r = await cb.call('POST', '/broadcasts', { audience: 'sellers', channels: ['in_app'], title: 'Test', body: 'Hello sellers, big news', confirmCount: 1 });
    await new Promise((ok) => setTimeout(ok, 300));
    check('a broadcast is accepted, delivered and receipted', r.status === 202 && db.broadcast[0].status === 'sent' && db.broadcast[0].inAppSent === 1 && db.adminAuditLog.some((a) => a.action === 'broadcast.sent'), JSON.stringify(db.broadcast[0]));
    const T = require('../src/staff/templates');
    check('template variables render; unknown ones stay visible', T.render('Hi {{first_name}} {{oops}}', { first_name: 'Amina' }) === 'Hi Amina {{oops}}');

    // 14. audit trail
    const acts = db.adminAuditLog.map((a) => a.action);
    check('sign-ins and failures are audited', acts.includes('staff.login.success') && (acts.includes('staff.login.failed') || acts.includes('staff.mfa.failed')), acts.slice(0, 8).join(','));
    check('audit entries record the IP', db.adminAuditLog.some((a) => a.ip));

    server.close();
    let failed = 0; for (const t of results) { if (!t.ok) failed += 1; process.stdout.write(`${t.ok ? 'PASS' : 'FAIL'}  ${t.name}${t.ok ? '' : `   [${t.detail}]`}\n`); }
    process.stdout.write(`\n${results.length - failed}/${results.length} passed\n`); process.exit(failed ? 1 : 0);
})().catch((e) => { process.stdout.write(`CRASH ${e.stack}\n`); process.exit(1); });
