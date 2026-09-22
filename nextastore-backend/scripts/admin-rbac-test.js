#!/usr/bin/env node
'use strict';
/*
 * Role-based access control for /api/admin, tested against the REAL
 * src/routes/admin.js and src/middleware.js. Express, Prisma, mail and the rest
 * are stubbed, so it needs no node_modules, database or network:
 *
 *   npm run test:admin-rbac
 *
 * Part 1 (route guards): every route the admin router registers is run through
 * its real middleware chain as each kind of caller (signed out, buyer, seller,
 * suspended admin, an admin with no role, an admin holding exactly ONE
 * permission for each of the 12 permissions, the three starter roles, a super
 * admin) and compared with an independent table of which permission each route
 * needs. A route missing from the table fails the test, so a new unguarded
 * endpoint cannot slip in.
 * Part 2 (rules inside the handlers): privilege-escalation, last-super-admin,
 * field-level edit/suspend rules, password-reset targets and the audit/follow-up
 * leak in the user detail response, against an in-memory fake database.
 *
 * Does NOT prove: real Express mounting, real Prisma queries, or the browser UI
 * (see test:admin-console-browser).
 */
const path = require('path');
const Module = require('module');
const SRC = path.resolve(__dirname, '..', 'src');
const jwtShim = require(path.join(__dirname, 'auth-browser-tests', 'shims', 'packages', 'jsonwebtoken'));
const results = [];
console.error = () => {}; // the reset route logs its (deliberately failing) test mail
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail });

// ---- fake database -----------------------------------------------------------
const db = { users: {}, roles: {}, calls: [], audit: [] };
const clone = (o) => JSON.parse(JSON.stringify(o));
const withRole = (u) => u && { ...u, adminRole: u.adminRoleId ? db.roles[u.adminRoleId] || null : null, store: u.store || null };
const inert = (model) => new Proxy({}, { get: (_t, method) => async (args) => {
    db.calls.push(`${model}.${String(method)}`);
    if (method === 'findMany') return [];
    if (method === 'count') return 0;
    return null;
} });
const fakePrisma = new Proxy({}, { get: (_t, model) => {
    if (model === '$transaction') return async (fn) => fn(fakePrisma);
    if (model === 'user') return {
        findUnique: async ({ where }) => withRole(db.users[where.id] ? clone(db.users[where.id]) : null),
        count: async ({ where = {} } = {}) => Object.values(db.users).filter((u) =>
            (where.role === undefined || u.role === where.role) &&
            (where.adminLevel === undefined || u.adminLevel === where.adminLevel) &&
            (where.accountStatus === undefined || u.accountStatus === where.accountStatus) &&
            (!where.id || where.id.not === undefined || u.id !== where.id.not)).length,
        update: async ({ where, data }) => { Object.assign(db.users[where.id], data); return withRole(clone(db.users[where.id])); },
        findMany: async () => []
    };
    if (model === 'adminRole') return {
        findUnique: async ({ where }) => { const r = db.roles[where.id]; return r ? { ...clone(r), _count: { users: Object.values(db.users).filter((u) => u.adminRoleId === r.id).length } } : null; },
        findMany: async () => Object.values(db.roles).map((r) => ({ ...clone(r), _count: { users: 0 } })),
        create: async ({ data }) => { const r = { id: `r_${Object.keys(db.roles).length + 1}`, ...data }; db.roles[r.id] = r; return clone(r); },
        update: async ({ where, data }) => { Object.assign(db.roles[where.id], data); return clone(db.roles[where.id]); },
        delete: async ({ where }) => { delete db.roles[where.id]; return {}; }
    };
    if (model === 'adminAuditLog') return { findMany: async () => { db.calls.push('adminAuditLog.findMany'); return []; }, create: async () => null };
    if (model === 'adminFollowUp') return { findMany: async () => { db.calls.push('adminFollowUp.findMany'); return []; }, count: async () => 3 };
    return inert(String(model));
} });

// ---- stubs -------------------------------------------------------------------
const routes = [];
const fakeExpress = { Router: () => { const r = {}; for (const v of ['get', 'post', 'put', 'delete', 'patch']) r[v] = (p, ...h) => { routes.push({ method: v.toUpperCase(), path: p, chain: h }); }; return r; } };
const config = { jwtSecret: 'test-secret', frontendUrl: 'http://localhost', sessionPolicies: {
    admin: { ttlSeconds: 3600, maxAgeSeconds: 86400 }, remember: { ttlSeconds: 3600, maxAgeSeconds: 86400 }, session: { ttlSeconds: 3600, maxAgeSeconds: 86400 } } };
const helpers = {
    createNotification: async () => null,
    getPlatformSettings: async () => ({}),
    recordAdminAudit: async (a) => { db.audit.push(a); },
    subscriptionInfo: () => null,
    SUBSCRIPTION_PRICE_UGX: 0
};
const origLoad = Module._load;
Module._load = function (request, parent) {
    const from = parent && parent.filename ? parent.filename : '';
    if (request === 'express') return fakeExpress;
    if (request === 'jsonwebtoken') return jwtShim;
    if (request === 'bcryptjs') return {};
    if (from.startsWith(SRC)) {
        if (/(^|\/)prisma$/.test(request)) return fakePrisma;
        if (/(^|\/)config$/.test(request)) return config;
        if (/(^|\/)helpers$/.test(request)) return helpers;
        if (/(^|\/)verification$/.test(request)) return { issueToken: async () => 'tok' };
        if (/(^|\/)mailer$/.test(request)) return { sendMail: async () => { throw new Error('no smtp in test'); } };
        if (/(^|\/)push$/.test(request)) return { removeAllSubscriptionsForUser: async () => null };
        if (/(^|\/)presence$/.test(request)) return { disconnectUser: () => null };
        if (/(^|\/)validation$/.test(request)) return new Proxy({ validateBody: () => (req, res, next) => next() }, { get: (t, k) => (k in t ? t[k] : {}) });
    }
    return origLoad.apply(this, arguments);
};
require(path.join(SRC, 'routes', 'admin.js'));
const { ADMIN_PERMISSIONS } = require(path.join(SRC, 'middleware.js'));
const ALL = Object.values(ADMIN_PERMISSIONS);

// ---- callers -----------------------------------------------------------------
const PERSONAS = {};
function persona(key, fields) {
    const roleId = fields.perms ? `role_${key}` : null;
    if (roleId) db.roles[roleId] = { id: roleId, name: fields.roleName || key, permissions: fields.perms };
    db.users[key] = { id: key, name: key, email: `${key}@x.test`, role: 'admin', adminLevel: 'standard', accountStatus: 'active', tokenVersion: 0, adminRoleId: roleId, ...fields.user };
    delete db.users[key].perms;
    PERSONAS[key] = { key, perms: fields.perms || [], super: db.users[key].adminLevel === 'super_admin', isAdmin: db.users[key].role === 'admin' && db.users[key].accountStatus === 'active' };
}
const STARTER = {
    store_manager: ['dashboard.view', 'users.view', 'users.edit', 'subscriptions.review', 'followups.manage'],
    support_agent: ['dashboard.view', 'users.view', 'users.password_reset', 'followups.manage'],
    moderator: ['dashboard.view', 'users.view', 'users.suspend', 'reports.review', 'followups.manage']
};
persona('buyer', { user: { role: 'buyer' } });
persona('seller', { user: { role: 'seller' } });
persona('suspended_admin', { perms: ALL, user: { accountStatus: 'suspended' } });
persona('admin_no_role', {});
persona('super', { user: { adminLevel: 'super_admin' } });
for (const [k, perms] of Object.entries(STARTER)) persona(k, { perms, roleName: k });
for (const p of ALL) persona(`only_${p}`, { perms: [p] });
db.users.buyer.adminRoleId = null;

const now = () => Math.floor(Date.now() / 1000);
const tokenFor = (id) => jwtShim.sign({ userId: id, rm: false, at: now(), tv: 0, iat: now(), exp: now() + 3000 }, config.jwtSecret, { algorithm: 'HS256' });

async function call(method, urlPath, who, { body = {}, params = {}, query = {} } = {}) {
    const route = routes.find((r) => r.method === method && r.path === urlPath);
    if (!route) throw new Error(`no route ${method} ${urlPath}`);
    const headers = who ? { authorization: `Bearer ${tokenFor(who)}` } : {};
    const req = { method, headers, params, body: clone(body), query, originalUrl: `/api/admin${urlPath}`, get: (h) => headers[h.toLowerCase()] };
    let outcome = null;
    const res = {
        statusCode: 200, headers: {},
        setHeader() {}, vary() {}, status(c) { this.statusCode = c; return this; },
        json(o) { outcome = outcome || { status: this.statusCode, body: o }; return this; }
    };
    for (const fn of route.chain) {
        if (outcome) break;
        let advanced = false;
        await new Promise((resolve) => {
            const next = (err) => { if (err) outcome = outcome || { status: err.status || 500, message: err.message, code: err.code }; else advanced = true; resolve(); };
            Promise.resolve(fn(req, res, next)).then(() => { if (outcome || advanced) resolve(); }, (e) => { outcome = { status: e.status || 500, message: e.message }; resolve(); });
        });
    }
    return outcome || { status: 200 };
}
const denied = (o) => o.status === 401 || o.status === 403;

// ---- Part 1: which permission each route needs (independent of the source) -----
const NEEDS = {
    'GET /overview': ['dashboard.view'],
    'GET /users': ['users.view'],
    'GET /users/:id': ['users.view'],
    'PUT /users/:id': ['users.edit', 'users.suspend'],
    'POST /users/:id/password-reset': ['users.password_reset'],
    'GET /administrators': ['followups.manage', 'admins.manage'],
    'GET /roles': ['roles.manage', 'admins.manage'],
    'POST /roles': ['roles.manage'],
    'PUT /roles/:id': ['roles.manage'],
    'DELETE /roles/:id': ['roles.manage'],
    'GET /follow-ups': ['followups.manage'],
    'POST /follow-ups': ['followups.manage'],
    'PUT /follow-ups/:id': ['followups.manage'],
    'GET /audit': ['audit.view'],
    'GET /reports': ['reports.review'],
    'PUT /reports/:id/review': ['reports.review'],
    'GET /subscription-payments': ['subscriptions.review'],
    'PUT /subscription-payments/:id/approve': ['subscriptions.review'],
    'PUT /subscription-payments/:id/reject': ['subscriptions.review'],
    'GET /settings': ['settings.manage'],
    'PUT /settings': ['settings.manage'],
    'GET /payment-methods': ['settings.manage'],
    'POST /payment-methods': ['settings.manage'],
    'PUT /payment-methods/:id': ['settings.manage'],
    'DELETE /payment-methods/:id': ['settings.manage']
};

(async () => {
    const keyOf = (r) => `${r.method} ${r.path}`;
    check('every admin route is in the permission table (and the table has no stale entries)',
        routes.map(keyOf).sort().join('|') === Object.keys(NEEDS).sort().join('|'),
        `router: ${routes.map(keyOf).filter((k) => !NEEDS[k]).join(', ') || 'ok'}; table only: ${Object.keys(NEEDS).filter((k) => !routes.find((r) => keyOf(r) === k)).join(', ') || 'ok'}`);

    // signed-out, wrong account type, suspended
    for (const r of routes) {
        const k = keyOf(r);
        const anon = await call(r.method, r.path, null, { params: { id: 'x' } });
        if (anon.status !== 401) check(`${k}: signed-out request is refused with 401`, false, `got ${anon.status}`);
        for (const who of ['buyer', 'seller', 'admin_no_role', 'suspended_admin']) {
            const o = await call(r.method, r.path, who, { params: { id: 'x' } });
            if (!denied(o)) check(`${k}: ${who} is refused`, false, `got ${o.status}`);
        }
    }
    check('every route refuses signed-out callers (401)', !results.some((x) => !x.ok && /signed-out/.test(x.name)));
    check('every route refuses buyers, sellers, suspended admins and admins with no role', !results.some((x) => !x.ok && / is refused$/.test(x.name)));

    // permission matrix
    let matrixBad = [];
    for (const r of routes) {
        const k = keyOf(r);
        const need = NEEDS[k] || [];
        for (const p of Object.values(PERSONAS)) {
            if (!p.isAdmin) continue;
            const expectAllowed = p.super || need.some((n) => p.perms.includes(n));
            const o = await call(r.method, r.path, p.key, { params: { id: 'x' }, body: {} });
            if (denied(o) === expectAllowed) matrixBad.push(`${k} as ${p.key}: expected ${expectAllowed ? 'allowed' : 'refused'}, got ${o.status}`);
        }
    }
    check(`permission matrix: ${routes.length} routes x ${Object.values(PERSONAS).filter((p) => p.isAdmin).length} admin callers all match`, matrixBad.length === 0, matrixBad.slice(0, 6).join(' ; '));

    // the three starter roles see exactly their modules
    const allowedFor = async (who) => { const a = []; for (const r of routes) { const o = await call(r.method, r.path, who, { params: { id: 'x' } }); if (!denied(o)) a.push(keyOf(r)); } return a; };
    const sup = await allowedFor('support_agent');
    check('Support Agent reaches users, password reset and follow-ups, but not payments, reports, roles, settings or audit',
        sup.includes('GET /users') && sup.includes('POST /users/:id/password-reset') && sup.includes('GET /follow-ups') &&
        !sup.some((k) => /subscription-payments|\/reports|\/roles|\/settings|payment-methods|\/audit/.test(k)) && !sup.includes('PUT /users/:id'));
    const mod = await allowedFor('moderator');
    check('Moderator reaches reports and the suspend route, but not payments, password reset, roles, settings or audit',
        mod.includes('GET /reports') && mod.includes('PUT /reports/:id/review') && mod.includes('PUT /users/:id') &&
        !mod.some((k) => /subscription-payments|password-reset|\/roles|\/settings|payment-methods|\/audit/.test(k)));
    const sm = await allowedFor('store_manager');
    check('Store Manager reaches accounts and Seller Pass payments, but not reports, roles, settings or audit',
        sm.includes('GET /subscription-payments') && sm.includes('PUT /subscription-payments/:id/approve') && sm.includes('PUT /users/:id') &&
        !sm.some((k) => /\/reports|\/roles|\/settings|payment-methods|\/audit|password-reset/.test(k)));
    const su = await allowedFor('super');
    check('Super Admin reaches every route', su.length === routes.length);

    // ---- Part 2: rules inside the handlers ----------------------------------
    const reset = () => {
        for (const id of Object.keys(db.users)) if (id.startsWith('t_')) delete db.users[id];
        for (const id of Object.keys(db.roles)) if (id.startsWith('tr_')) delete db.roles[id];
        db.calls.length = 0; db.audit.length = 0;
        db.users.t_buyer = { id: 't_buyer', name: 'Bea Buyer', email: 'bea@x.test', role: 'buyer', adminLevel: 'standard', accountStatus: 'active', adminRoleId: null };
        db.users.t_admin = { id: 't_admin', name: 'Adam Admin', email: 'adam@x.test', role: 'admin', adminLevel: 'standard', accountStatus: 'active', adminRoleId: null };
        db.users.t_super2 = { id: 't_super2', name: 'Sue Super', email: 'sue@x.test', role: 'admin', adminLevel: 'super_admin', accountStatus: 'active', adminRoleId: null };
    };
    const put = (who, id, body) => call('PUT', '/users/:id', who, { params: { id }, body });

    reset();
    let o = await put('moderator', 't_buyer', { name: 'Bea Buyer', email: 'bea@x.test', role: 'buyer', accountStatus: 'suspended' });
    check('Moderator (suspend only) can suspend a buyer when the unchanged fields are resent', o.status === 200 && db.users.t_buyer.accountStatus === 'suspended', JSON.stringify(o));
    o = await put('moderator', 't_buyer', { accountStatus: 'active' });
    check('Moderator can reactivate the account it suspended', o.status === 200 && db.users.t_buyer.accountStatus === 'active', JSON.stringify(o));
    o = await put('moderator', 't_buyer', { name: 'Renamed' });
    check('Moderator cannot edit account details (403)', o.status === 403 && db.users.t_buyer.name === 'Bea Buyer', JSON.stringify(o));
    reset();
    o = await put('store_manager', 't_buyer', { name: 'Bea B.', email: 'bea@x.test', role: 'buyer', accountStatus: 'active' });
    check('Store Manager (edit only) can rename an account', o.status === 200 && db.users.t_buyer.name === 'Bea B.', JSON.stringify(o));
    o = await put('store_manager', 't_buyer', { accountStatus: 'suspended' });
    check('Store Manager cannot suspend (403)', o.status === 403 && db.users.t_buyer.accountStatus === 'active', JSON.stringify(o));
    o = await put('store_manager', 't_buyer', { role: 'admin' });
    check('Store Manager cannot turn an account into an administrator (403)', o.status === 403 && db.users.t_buyer.role === 'buyer', JSON.stringify(o));
    o = await put('store_manager', 't_admin', { name: 'Hacked' });
    check('Store Manager cannot edit an administrator (403)', o.status === 403 && db.users.t_admin.name === 'Adam Admin', JSON.stringify(o));
    o = await put('store_manager', 't_super2', { name: 'Hacked' });
    check('Store Manager cannot edit a super admin (403)', o.status === 403 && db.users.t_super2.name === 'Sue Super', JSON.stringify(o));

    // privilege escalation via role assignment
    reset();
    db.roles.tr_powerful = { id: 'tr_powerful', name: 'Powerful', permissions: ['roles.manage', 'settings.manage', 'users.edit'] };
    db.roles.tr_modest = { id: 'tr_modest', name: 'Modest', permissions: ['users.view'] };
    persona('t_hr', { perms: ['users.view', 'users.edit', 'admins.manage'], roleName: 'hr' });
    o = await put('t_hr', 't_admin', { adminRoleId: 'tr_powerful' });
    check('an admin with "manage admins" cannot assign a role holding permissions they lack (403)', o.status === 403 && !db.users.t_admin.adminRoleId, JSON.stringify(o));
    o = await put('t_hr', 't_hr', { adminRoleId: 'tr_powerful' });
    check('...nor promote themselves into one (403)', o.status === 403 && db.users.t_hr.adminRoleId !== 'tr_powerful', JSON.stringify(o));
    o = await put('t_hr', 't_admin', { adminRoleId: 'tr_modest' });
    check('...but can assign a role made only of permissions they hold', o.status === 200 && db.users.t_admin.adminRoleId === 'tr_modest', JSON.stringify(o));
    o = await put('t_hr', 't_admin', { adminLevel: 'super_admin' });
    check('an admin with "manage admins" cannot grant super-admin level (403)', o.status === 403 && db.users.t_admin.adminLevel === 'standard', JSON.stringify(o));
    o = await put('super', 't_admin', { adminRoleId: 'tr_powerful' });
    check('a super admin can assign any role', o.status === 200 && db.users.t_admin.adminRoleId === 'tr_powerful', JSON.stringify(o));

    // last super admin
    reset();
    db.users.super.adminLevel = 'super_admin';
    for (const id of Object.keys(db.users)) if (id !== 'super' && db.users[id].adminLevel === 'super_admin') db.users[id].adminLevel = 'standard';
    o = await put('super', 'super', { adminLevel: 'standard' });
    check('the last active super admin cannot demote themselves (409)', o.status === 409 && db.users.super.adminLevel === 'super_admin', JSON.stringify(o));
    o = await put('super', 'super', { role: 'buyer' });
    check('...nor switch themselves to a buyer account (409)', o.status === 409 && db.users.super.role === 'admin', JSON.stringify(o));
    db.users.t_super2.adminLevel = 'super_admin';
    o = await put('super', 't_super2', { accountStatus: 'suspended' });
    check('with two super admins, one can suspend the other', o.status === 200 && db.users.t_super2.accountStatus === 'suspended', JSON.stringify(o));
    db.users.t_super2.accountStatus = 'active';
    o = await put('super', 'super', { accountStatus: 'suspended' });
    check('nobody can suspend their own account (400)', o.status === 400, JSON.stringify(o));
    db.users.t_super2.adminLevel = 'standard';

    // password reset targets
    reset();
    o = await call('POST', '/users/:id/password-reset', 'support_agent', { params: { id: 't_buyer' } });
    check('Support Agent can start a password reset for a buyer', o.status === 200, JSON.stringify(o));
    o = await call('POST', '/users/:id/password-reset', 'support_agent', { params: { id: 't_admin' } });
    check('Support Agent cannot start a reset for an administrator (403)', o.status === 403, JSON.stringify(o));
    o = await call('POST', '/users/:id/password-reset', 'support_agent', { params: { id: 't_super2' } });
    check('Support Agent cannot start a reset for a super admin (403)', o.status === 403, JSON.stringify(o));
    o = await call('POST', '/users/:id/password-reset', 'super', { params: { id: 't_super2' } });
    check('a super admin can', o.status === 200 && o.body.data.resetUrl && /token=tok/.test(o.body.data.resetUrl), JSON.stringify(o));
    o = await call('POST', '/users/:id/password-reset', 'support_agent', { params: { id: 't_buyer' } });
    check('the reset link is never returned to a non-super admin', o.status === 200 && o.body.data.resetUrl === undefined, JSON.stringify(o));

    // roles: cannot grant what you do not hold
    reset();
    persona('t_rm', { perms: ['roles.manage', 'users.view'], roleName: 'rm' });
    db.roles.tr_full = { id: 'tr_full', name: 'Full', permissions: ['settings.manage', 'users.view'] };
    o = await call('POST', '/roles', 't_rm', { body: { name: 'Sneaky', description: '', permissions: ['settings.manage'] } });
    check('roles.manage cannot create a role holding a permission they lack (403)', o.status === 403 && !Object.values(db.roles).some((r) => r.name === 'Sneaky'), JSON.stringify(o));
    o = await call('POST', '/roles', 't_rm', { body: { name: 'Viewer', description: '', permissions: ['users.view'] } });
    check('...but can create one from permissions they hold', o.status === 201, JSON.stringify(o));
    o = await call('PUT', '/roles/:id', 't_rm', { params: { id: 'role_t_rm' }, body: { name: 'rm', description: '', permissions: ['roles.manage', 'users.view', 'settings.manage'] } });
    check('...cannot add a permission to their own role (403)', o.status === 403 && !db.roles.role_t_rm.permissions.includes('settings.manage'), JSON.stringify(o));
    o = await call('PUT', '/roles/:id', 't_rm', { params: { id: 'tr_full' }, body: { name: 'Full', description: '', permissions: ['users.view'] } });
    check('...cannot edit a stronger role even to weaken it (403)', o.status === 403 && db.roles.tr_full.permissions.length === 2, JSON.stringify(o));
    o = await call('DELETE', '/roles/:id', 't_rm', { params: { id: 'tr_full' } });
    check('...cannot delete a stronger role (403)', o.status === 403 && !!db.roles.tr_full, JSON.stringify(o));
    o = await call('PUT', '/roles/:id', 'super', { params: { id: 'tr_full' }, body: { name: 'Full', description: '', permissions: ['users.view'] } });
    check('a super admin can edit any role', o.status === 200 && db.roles.tr_full.permissions.length === 1, JSON.stringify(o));
    o = await call('GET', '/roles', 'support_agent');
    check('the role list is not readable without roles.manage / admins.manage (403)', o.status === 403, JSON.stringify(o));

    // user detail leaks
    reset();
    db.calls.length = 0;
    o = await call('GET', '/users/:id', 'support_agent', { params: { id: 't_buyer' } });
    check('account detail for a Support Agent includes follow-ups but not the audit trail', o.status === 200 && db.calls.includes('adminFollowUp.findMany') && !db.calls.includes('adminAuditLog.findMany'), JSON.stringify(db.calls));
    db.calls.length = 0;
    o = await call('GET', '/users/:id', 'store_manager', { params: { id: 't_buyer' } });
    check('...and for a Store Manager includes follow-ups (has the permission)', o.status === 200 && db.calls.includes('adminFollowUp.findMany'));
    db.calls.length = 0;
    o = await call('GET', '/users/:id', 'only_users.view', { params: { id: 't_buyer' } });
    check('...but for a view-only admin neither follow-ups nor audit trail are read', o.status === 200 && !db.calls.includes('adminFollowUp.findMany') && !db.calls.includes('adminAuditLog.findMany'), JSON.stringify(db.calls));
    db.calls.length = 0;
    o = await call('GET', '/users/:id', 'super', { params: { id: 't_buyer' } });
    check('...and a super admin gets both', db.calls.includes('adminFollowUp.findMany') && db.calls.includes('adminAuditLog.findMany'));

    // overview only counts what the caller may open
    o = await call('GET', '/overview', 'moderator');
    check('overview for a Moderator leaves out the payment and administrator counts they cannot open',
        o.status === 200 && o.body.data.pendingPayments === null && o.body.data.admins === null && o.body.data.openReports !== null, JSON.stringify(o.body));
    o = await call('GET', '/overview', 'only_users.view');
    check('an admin without dashboard.view gets no overview at all (403)', o.status === 403, JSON.stringify(o));

    // ---- report ----------------------------------------------------------------
    let failed = 0;
    for (const r of results) { console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${!r.ok && r.detail ? `  -> ${r.detail}` : ''}`); if (!r.ok) failed++; }
    console.log(`\n${results.length - failed}/${results.length} admin RBAC checks passed.`);
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
