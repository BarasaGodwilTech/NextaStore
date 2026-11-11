/**
 * Shared test environment for the browser tests: the REAL growth backend (routes, services, hooks, host router)
 * on an in-memory database, plus a small HTTP server that serves
 *   - the growth pages from the project root (they win),
 *   - YOUR site files from PROJECT_DIR, or the bundled stub site when PROJECT_DIR is not set.
 * One server answers for every host name (main, circle., crew.), exactly like one Express app behind a proxy.
 */
const path = require('path');
const fs = require('fs');
const http = require('http');
const Module = require('module');

const OVERLAY = path.join(__dirname, '..', '..', '..');
const STUB = path.join(__dirname, 'stub-site');

// Use the fake Express for routes.js (the real one is not needed here).
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) { return request === 'express' ? path.join(__dirname, 'fake-express.js') : origResolve.call(this, request, ...rest); };
const FE = require('./fake-express');
const { createGrowth } = require('../../src/growth');
const { createHosts } = require('../../src/growth/hosts');
const { createMemoryPrisma } = require('./memory-prisma');

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp' };

function createEnv({ projectDir = process.env.PROJECT_DIR, hostsConfig = { mode: 'path' } } = {}) {
    const PROJECT = projectDir && fs.existsSync(path.join(projectDir, 'js', 'main.js')) ? projectDir : STUB;
    let offsetMs = 0;
    const clock = () => new Date(Date.now() + offsetMs);
    const prisma = createMemoryPrisma(clock);
    const db = prisma._db;
    const hosts = createHosts(hostsConfig);
    const growth = createGrowth({
        prisma, now: clock, hosts,
        createNotification: async (n) => { db.notification.push({ id: prisma._uid(), createdAt: clock(), ...n }); },
        recordAdminAudit: async () => {},
        savePrivateImage: async (dataUrl, folder) => `private/${folder}/${Date.now()}.png`
    });
    const hostRouter = growth.hostRouter({ pagesDir: OVERLAY, cache: false });

    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const tokenFor = (user, ttlSec = 3600) => `${b64({ alg: 'none' })}.${b64({ userId: user.id, role: user.role, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + ttlSec })}.${Math.random().toString(36).slice(2, 10)}`;
    const userFromReq = (req) => { try { const t = (req.headers.authorization || '').replace(/^Bearer\s+/i, ''); const id = JSON.parse(Buffer.from(t.split('.')[1], 'base64url')).userId; return db.user.find((u) => u.id === id) || null; } catch (e) { return null; } };
    const mw = {
        requireAuth: (req, res, next) => { const u = userFromReq(req); if (!u) { res.status(401).json({ message: 'Please sign in.' }); return res.done(); } req.user = u; next(); },
        requireAdminPermission: () => (req, res, next) => (req.user.role === 'admin' ? next() : (res.status(403).json({ message: 'You do not have permission for this.' }), res.done())),
        limiter: (req, res, next) => next(),
        sendKyc: (req, res, key) => res.json({ data: { key } })
    };
    const routers = growth.routes(mw);
    const MOUNTS = [['/api/admin/growth', routers.admin], ['/api/growth', routers.partner]];

    const unknownApi = new Set();
    function sendFile(res, file) { res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' }); fs.createReadStream(file).pipe(res); }
    function serveStatic(res, pathname) {
        const clean = decodeURIComponent(pathname).replace(/\.\./g, '');
        const candidates = [];
        // OVERLAY is the project root now, which also holds the real site. Only the growth program's own files may
        // win over the stub or the PROJECT_DIR site; the real signup.html, index.html and so on must not shadow them.
        const isGrowthFile = /^\/(admin-growth|auth-bridge|circle|crew|invite)(\.html)?$|^\/css\/growth\.css$|^\/js\/(growth[a-z-]*|invite|admin-growth)\.js$|^\/assets\/growth-brand\//.test(clean);
        for (const [i, base] of [OVERLAY, PROJECT].entries()) { if (i === 0 && !isGrowthFile) continue; if (clean === '/') candidates.push(path.join(base, 'index.html')); candidates.push(path.join(base, clean)); if (!path.extname(clean)) candidates.push(path.join(base, `${clean}.html`)); }
        if (clean === '/__widget') candidates.unshift(path.join(__dirname, 'widget-fixture.html'));
        const hit = candidates.find((f) => fs.existsSync(f) && fs.statSync(f).isFile());
        if (!hit) { res.writeHead(404); return res.end('not found'); }
        return sendFile(res, hit);
    }

    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, 'http://x');
        res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', '*'); res.setHeader('Access-Control-Allow-Methods', '*');
        if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
        // The host router goes first, like in the real app.
        const handled = await new Promise((resolve) => { let nexted = false; hostRouter(req, res, () => { nexted = true; resolve(false); }); if (!nexted) setImmediate(() => resolve(res.writableEnded || res.headersSent)); });
        if (handled && (res.writableEnded || res.headersSent)) return undefined;
        if (!url.pathname.startsWith('/api/')) return serveStatic(res, url.pathname);

        let body = ''; for await (const chunk of req) body += chunk;
        req.body = body ? JSON.parse(body) : {}; req.query = Object.fromEntries(url.searchParams); req.ip = '127.0.0.1';
        res.status = (c) => { res.statusCode = c; return res; };
        res.json = (o) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); res.done && res.done(); };
        res.fail = (err) => { res.statusCode = err.status || 500; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ message: err.message, code: err.code })); if (!err.status) console.error('[server] unexpected:', err); res.done && res.done(); };
        for (const [prefix, router] of MOUNTS) {
            if (!url.pathname.startsWith(`${prefix}/`)) continue;
            const m = FE.match(router, req.method, url.pathname.slice(prefix.length));
            if (!m) break;
            req.params = m.params;
            return FE.run(m.route, req, res);
        }
        const user = userFromReq(req);
        const p = url.pathname.replace(/^\/api/, '');
        if (p === '/user/me') return user ? res.json({ data: { ...user, emailVerified: true } }) : res.status(401).json({ message: 'Please sign in.' }).end();
        if (p === '/store') return res.json({ data: db.store.find((s) => s.ownerId === user?.id) || null });
        if (p.startsWith('/notifications') || p.startsWith('/messages')) return res.json({ data: p.includes('count') ? { count: 0, unread: 0 } : [], unread: 0, count: 0 });
        unknownApi.add(`${req.method} ${p}`);
        return res.json({ data: null });
    });

    let uid = 0;
    const mkUser = (name, extra = {}) => { const id = `bu${++uid}`; const u = { id, name, email: `${name.toLowerCase().replace(/\W/g, '')}${uid}@mail.test`, role: 'seller', accountStatus: 'active', emailVerifiedAt: new Date(), createdAt: new Date(), ...extra }; db.user.push(u); return u; };

    return { PROJECT, OVERLAY, usingStub: PROJECT === STUB, clock, setOffset: (ms) => { offsetMs = ms; }, prisma, db, growth, hosts, tokenFor, mkUser, server, unknownApi, listen: (port) => new Promise((r) => server.listen(port, r)) };
}

module.exports = { createEnv, OVERLAY, STUB };
