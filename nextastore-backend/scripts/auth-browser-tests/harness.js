'use strict';
/*
 * Browser-test harness for the auth/session work (round 8, step 4).
 *
 * What is REAL here:  the frontend files in the repo root (served as-is),
 *                     src/middleware.js and src/config.js (token signing,
 *                     verification, sliding renewal, absolute cap, revocation,
 *                     background-poll rule).
 * What is a STAND-IN: the database (an in-memory user table replaces Prisma)
 *                     and the route handlers (login, logout-all, a couple of
 *                     fake message endpoints). The real routes/*.js need
 *                     express, zod, bcrypt, Postgres etc.; the point of this
 *                     harness is the session behaviour, not the business logic.
 *
 * The SERVER clock can be moved (POST /__test/advance?seconds=N) so a test can
 * age a token by days without waiting. The BROWSER clock is moved separately by
 * the test (Playwright's page/context clock).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const Module = require('module');

process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'browser-test-secret-not-for-production-0123456789abcdef';
delete process.env.JWT_EXPIRES_IN; // use the documented defaults, whatever the developer's shell has

// Real packages win; the shims are only consulted if a package is missing.
process.env.NODE_PATH = [process.env.NODE_PATH, path.join(__dirname, 'shims', 'packages')].filter(Boolean).join(path.delimiter);
Module._initPaths();

const BACKEND_SRC = path.resolve(__dirname, '..', '..', 'src');
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

// --- fake database ---------------------------------------------------------
const seedUsers = () => ({
    u_seller: { id: 'u_seller', name: 'Sade Seller', email: 'seller@test.dev', role: 'seller', accountStatus: 'active', tokenVersion: 0, adminRole: null, password: 'Passw0rd!seller' },
    u_buyer: { id: 'u_buyer', name: 'Bosco Buyer', email: 'buyer@test.dev', role: 'buyer', accountStatus: 'active', tokenVersion: 0, adminRole: null, password: 'Passw0rd!buyer' },
    u_buyer2: { id: 'u_buyer2', name: 'Bea Buyer', email: 'buyer2@test.dev', role: 'buyer', accountStatus: 'active', tokenVersion: 0, adminRole: null, password: 'Passw0rd!buyer2' }
});
let users = seedUsers();
const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, accountStatus: u.accountStatus });

const prismaPath = require.resolve(path.join(BACKEND_SRC, 'prisma'));
require.cache[prismaPath] = {
    id: prismaPath, filename: prismaPath, loaded: true,
    exports: { user: { findUnique: async ({ where }) => (users[where.id] ? { ...users[where.id] } : null) } }
};

// --- server clock ------------------------------------------------------------
const realNow = Date.now.bind(Date);
let offsetMs = 0;
Date.now = () => realNow() + offsetMs;

const config = require(path.join(BACKEND_SRC, 'config'));
const { signSessionToken, requireAuth, optionalAuth, errorHandler } = require(path.join(BACKEND_SRC, 'middleware'));

// --- request log -----------------------------------------------------------
let log = [];
let flags = {};
let seq = 0;
const decodeUserId = (req) => {
    try { return JSON.parse(Buffer.from((req.headers.authorization || '').split('.')[1], 'base64url').toString()).userId || null; } catch (e) { return null; }
};

// --- express-ish glue --------------------------------------------------------
function decorate(req, res) {
    req.originalUrl = req.url;
    req.get = (n) => req.headers[String(n).toLowerCase()];
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (o) => { if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); };
    res.vary = (f) => { const cur = res.getHeader('Vary'); res.setHeader('Vary', cur ? `${cur}, ${f}` : f); };
}
const runMw = (mw, req, res) => new Promise((resolve, reject) => {
    Promise.resolve(mw(req, res, (err) => (err ? reject(err) : resolve()))).catch(reject);
});
const readJson = (req) => new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { resolve({}); } });
});

const CONV = () => ({
    id: 'c1', unreadCount: 0, updatedAt: new Date(Date.now()).toISOString(),
    buyer: { id: 'u_buyer', name: 'Bosco Buyer' },
    store: { id: 's1', name: 'Kampala Crafts', slug: 'kampala-crafts', logo: null },
    product: null,
    lastMessage: { id: 'm1', body: 'Hello there', type: 'text', createdAt: '2026-09-19T08:00:00.000Z' }
});

async function api(req, res, url) {
    const p = url.pathname.replace(/^\/api/, '');
    const body = req.method === 'GET' ? {} : await readJson(req);

    if (req.method === 'POST' && p === '/auth/login') {
        const u = Object.values(users).find((x) => x.email === String(body.email || '').toLowerCase());
        if (!u || u.password !== body.password) return res.status(401).json({ message: 'Email or password is incorrect.' });
        if (u.accountStatus === 'suspended') return res.status(403).json({ message: 'This account is suspended.', code: 'ACCOUNT_SUSPENDED' });
        return res.json({ token: signSessionToken(u, !!body.rememberMe), user: publicUser(u) });
    }

    // Everything below needs a valid session, like the real routes.
    if (['/user/me', '/store', '/auth/logout-all', '/notifications/unread-count', '/messages/unread-count'].includes(p) || p.startsWith('/messages/') || p === '/messages') {
        await runMw(requireAuth, req, res);
    } else {
        await runMw(optionalAuth, req, res);
    }

    if (p === '/user/me') return res.json({ data: publicUser(users[req.user.id]) });
    if (p === '/store') return res.json({ data: null });
    if (p === '/notifications/unread-count' || p === '/messages/unread-count') return res.json({ data: { count: 0 } });
    if (req.method === 'POST' && p === '/auth/logout-all') {
        users[req.user.id].tokenVersion += 1; // what the real route does with prisma `increment`
        return res.json({ message: 'Signed out everywhere.' });
    }
    if (p === '/messages/conversations') return res.json({ data: [CONV()], pagination: { page: 1, limit: 20, total: 1, pages: 1 } });
    if (p === '/messages/conversations/c1') {
        const serverTime = new Date(Date.now()).toISOString();
        if (url.searchParams.has('since')) {
            return res.json({ data: { messages: [], readUpdates: [], pagination: { truncated: !!flags.truncateThread, serverTime } } });
        }
        return res.json({ data: { id: 'c1', store: CONV().store, messages: [{ id: 'm1', senderId: 'u_seller', body: 'Hello there', type: 'text', createdAt: '2026-09-19T08:00:00.000Z', readAt: null }], pagination: { hasMore: false, nextBefore: null, serverTime } } });
    }
    return res.json({ data: [] });
}

function testControl(req, res, url) {
    const q = url.searchParams;
    if (url.pathname === '/__test/advance') { offsetMs += Number(q.get('seconds') || 0) * 1000; return res.json({ offsetSeconds: offsetMs / 1000 }); }
    if (url.pathname === '/__test/reset') { users = seedUsers(); offsetMs = 0; log = []; flags = {}; return res.json({ ok: true }); }
    if (url.pathname === '/__test/clearlog') { log = []; return res.json({ ok: true }); }
    if (url.pathname === '/__test/log') return res.json(log);
    if (url.pathname === '/__test/flag') { flags[q.get('name')] = q.get('value') === '1'; return res.json(flags); }
    if (url.pathname === '/__test/user') return res.json(users[q.get('id')] || null);
    res.statusCode = 404; res.end('no such control');
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
function serveStatic(req, res, url) {
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/') rel = '/index.html';
    const file = path.normalize(path.join(REPO_ROOT, rel));
    if (!file.startsWith(REPO_ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.statusCode = 404; return res.end('not found'); }
    res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store');
    fs.createReadStream(file).pipe(res);
}

function start(port = 4000) {
    const server = http.createServer(async (req, res) => {
        decorate(req, res);
        const url = new URL(req.url, 'http://localhost');
        try {
            if (url.pathname.startsWith('/__test/')) return testControl(req, res, url);
            if (url.pathname.startsWith('/api/')) {
                const entry = { seq: ++seq, method: req.method, path: url.pathname.replace(/^\/api/, ''), query: url.search, bg: req.get('x-background-poll') === '1', userId: decodeUserId(req), at: Date.now() };
                res.on('finish', () => { entry.status = res.statusCode; entry.renewed = !!res.getHeader('X-Session-Token'); log.push(entry); });
                try { return await api(req, res, url); } catch (err) { return errorHandler(err, req, res, () => {}); }
            }
            return serveStatic(req, res, url);
        } catch (err) { res.statusCode = 500; res.end(String(err && err.stack || err)); }
    });
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => resolve({
            port, server, close: () => new Promise((r) => server.close(r)),
            policies: config.sessionPolicies
        }));
    });
}

module.exports = { start };
if (require.main === module) start(Number(process.env.PORT || 4000)).then((h) => console.log(`harness on http://localhost:${h.port}`));
