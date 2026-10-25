/**
 * Host router: makes circle.yourdomain.com and crew.yourdomain.com behave like their own small sites
 * while the whole thing stays ONE Express app and ONE API.
 *
 *   app.use(growth.hostRouter({ pagesDir: path.join(__dirname, '..') }));   // mount BEFORE express.static / clean URLs
 *
 * It uses only the plain Node response API (setHeader, statusCode, end), so it works in Express and in a
 * bare http server. In "path" mode (the default) it only serves the three pages with correct link-preview
 * tags and the short /i/CODE invite link; nothing else changes.
 *
 *   circle host    /            Circle dashboard (circle.html)
 *                  /invite, /i/CODE   the invite landing page (the one shared link host for everyone)
 *   crew host      /            Crew dashboard (crew.html); /invite and /i/CODE move to the circle host
 *   both hosts     /api/*, /css, /js, /assets, fonts, images: passed on to your normal handlers
 *                  /sw.js, /manifest.json, /favicon.ico: this program's own (so it installs as its own app)
 *                  anything else (/login, /marketplace, /admin ...): redirected to the same path on the main site
 *   main host      /circle, /crew, /scouts (old name), /invite, /i/CODE: redirected to the right subdomain (old links and
 *                  notifications keep working). /auth-bridge may be framed by the two subdomains only.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const STATIC_EXT = new Set(['.css', '.js', '.map', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.woff', '.woff2', '.ttf', '.otf', '.json', '.txt', '.mp3']);
const PASS_PREFIXES = ['/api/', '/css/', '/js/', '/assets/', '/webfonts/', '/fonts/', '/img/', '/images/'];
const PASS_EXACT = new Set(['/health', '/healthz', '/robots.txt']);

const PAGES = { circle: 'circle.html', crew: 'crew.html', invite: 'invite.html' };

function createHostRouter(opts = {}) {
    const { hosts } = opts;
    if (!hosts) throw new Error('growth hostRouter: pass { hosts } (growth.hostRouter does this for you).');
    const pagesDir = opts.pagesDir;
    if (!pagesDir) throw new Error('growth hostRouter: pagesDir is required (the folder that holds circle.html, crew.html, invite.html).');
    const cache = opts.cache !== undefined ? opts.cache : process.env.NODE_ENV === 'production';
    const apiCors = opts.apiCors !== false;                     // answer CORS for the three growth origins (needed only if the API is on another host)
    const passPrefixes = opts.passPrefixes || PASS_PREFIXES;
    const sub = hosts.mode === 'subdomain';

    const memo = new Map();
    function readText(rel) {
        if (cache && memo.has(rel)) return memo.get(rel);
        const text = fs.readFileSync(path.join(pagesDir, rel), 'utf8');
        if (cache) memo.set(rel, text);
        return text;
    }

    const send = (res, status, type, body, headers = {}) => {
        res.statusCode = status;
        res.setHeader('Content-Type', type);
        for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
        res.end(body);
    };
    const redirect = (res, url, status = 302) => { res.statusCode = status; res.setHeader('Location', url); res.setHeader('Cache-Control', 'no-store'); res.end(); };

    const requestOrigin = (req) => {
        const proto = String(req.headers['x-forwarded-proto'] || (req.socket && req.socket.encrypted ? 'https' : 'http')).split(',')[0].trim();
        return `${proto}://${req.headers.host}`;
    };

    /** Fill in the markers every page carries: the host settings for the browser and absolute URLs for link previews. */
    function renderPage(file, req, program) {
        const here = requestOrigin(req);
        const programUrl = sub ? hosts.programOrigin(program) : here;
        const cfg = JSON.stringify(hosts.publicConfig()).replace(/</g, '\\u003c');
        return readText(file)
            .replace(/<!--NEXTA_HOSTS-->/g, `<script>window.NEXTA_HOSTS=${cfg};</script>`)
            .replace(/\{\{PROGRAM_URL\}\}/g, programUrl)
            .replace(/\{\{MAIN_URL\}\}/g, sub ? hosts.origins.main : here);
    }
    function sendPage(req, res, file, program) {
        try {
            send(res, 200, 'text/html; charset=utf-8', renderPage(file, req, program), { 'Cache-Control': 'no-cache' });
        } catch (err) { send(res, 500, 'text/plain; charset=utf-8', 'This page is not available right now.'); }
    }

    function manifestFor(program) {
        const crew = program === 'crew';
        const dir = `/assets/growth-brand/favicon/${crew ? 'crew' : 'circle'}`;
        return {
            id: '/', name: crew ? 'NextaStore Crew' : 'NextaStore Circle', short_name: crew ? 'Crew' : 'Circle',
            description: crew ? 'NextaStore Crew, the field team. Find the stores worth finding and bring them in.' : 'NextaStore Circle, the affiliate program. Add stores to your circle and earn when they pay.',
            start_url: '/', scope: '/', display: 'standalone', background_color: '#F4FBF8', theme_color: '#0B3B2B',
            icons: [
                { src: `${dir}/icon-192.png`, sizes: '192x192', type: 'image/png', purpose: 'any' },
                { src: `${dir}/icon-512.png`, sizes: '512x512', type: 'image/png', purpose: 'any' },
                { src: `${dir}/icon-maskable-512.png`, sizes: '512x512', type: 'image/png', purpose: 'maskable' }
            ]
        };
    }

    function sendFileIfThere(res, rel, type, headers) {
        try { send(res, 200, type, fs.readFileSync(path.join(pagesDir, rel)), headers); return true; }
        catch (err) { return false; }
    }

    const isPassThrough = (p) => PASS_EXACT.has(p) || passPrefixes.some((x) => p.startsWith(x)) || STATIC_EXT.has(path.extname(p).toLowerCase());

    // CORS for the three growth origins, only when the page and the API are on different hosts.
    function cors(req, res) {
        const origin = req.headers.origin;
        if (!apiCors || !origin || !hosts.isAllowedOrigin(origin)) return false;
        if (origin === requestOrigin(req)) return false;
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        res.setHeader('Access-Control-Max-Age', '600');
        if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return true; }
        return false;
    }

    return function growthHostRouter(req, res, next) {
        // Prefix a fixed origin instead of using it as a base: a request line like "//evil.com" must stay a PATH, never become a host.
        const url = new URL(`http://x${String(req.url).startsWith('/') ? '' : '/'}${req.url}`);
        const p = url.pathname.replace(/\/{2,}/g, '/');
        const qs = url.search;
        const method = req.method;

        if (p.startsWith('/api/') && cors(req, res)) return undefined;

        const inviteMatch = p.match(/^\/i\/([A-Za-z0-9-]{1,24})\/?$/);
        const isInvitePath = p === '/invite' || p === '/invite.html' || !!inviteMatch;
        const readOnly = method === 'GET' || method === 'HEAD';

        // ----------------------------------------------------------- path mode (no subdomains)
        if (!sub) {
            if (!readOnly) return next();
            if (p === '/circle' || p === '/circle.html') return sendPage(req, res, PAGES.circle, 'circle');
            if (p === '/crew' || p === '/crew.html') return sendPage(req, res, PAGES.crew, 'crew');
            if (p === '/scouts' || p === '/scouts.html') return redirect(res, '/crew' + qs, 301);   // the old name
            if (p === '/invite' || p === '/invite.html') return sendPage(req, res, PAGES.invite, 'circle');
            if (inviteMatch) return sendPage(req, res, PAGES.invite, 'circle');
            return next();
        }

        const kind = hosts.kindOfHost(req.headers.host);

        // ----------------------------------------------------------- main site
        if (kind === null) return next();                           // an unknown host (health checks, the load balancer): not ours to touch
        if (kind === 'main') {
            if (readOnly) {
                if (p === '/circle' || p === '/circle.html') return redirect(res, hosts.programUrl('circle', '/') + qs);
                if (p === '/crew' || p === '/crew.html' || p === '/scouts' || p === '/scouts.html') return redirect(res, hosts.programUrl('scout', '/') + qs);
                if (isInvitePath) return redirect(res, hosts.origins.circle + p.replace(/\.html$/, '') + qs);
                if (p === '/auth-bridge' || p === '/auth-bridge.html') {
                    // Only the two program hosts may frame the session check; the page itself re-checks every origin it talks to.
                    res.removeHeader && res.removeHeader('X-Frame-Options');
                    res.setHeader('Content-Security-Policy', `frame-ancestors ${hosts.origins.circle} ${hosts.origins.crew}`);
                    res.setHeader('Referrer-Policy', 'no-referrer');
                    res.setHeader('Cache-Control', 'no-store');
                    try { res.statusCode = 200; res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(renderPage('auth-bridge.html', req, 'circle')); return undefined; }
                    catch (err) { /* file missing: fall through to the site's own 404 */ }
                }
            }
            return next();
        }

        // ----------------------------------------------------------- circle. and crew.
        const program = kind;                                       // 'circle' | 'crew'
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('X-Frame-Options', 'DENY');                   // nobody should be able to frame a page with money buttons on it
        res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

        if (isPassThrough(p) && !['/sw.js', '/manifest.json', '/site.webmanifest', '/manifest.webmanifest', '/favicon.ico'].includes(p)) return next();
        if (!readOnly) return next();

        if (p === '/sw.js') {
            if (sendFileIfThere(res, 'js/growth-sw.js', 'text/javascript; charset=utf-8', { 'Cache-Control': 'no-cache', 'Service-Worker-Allowed': '/' })) return undefined;
            return send(res, 404, 'text/plain', 'not found');
        }
        if (p === '/manifest.json' || p === '/site.webmanifest' || p === '/manifest.webmanifest') {
            return send(res, 200, 'application/manifest+json; charset=utf-8', JSON.stringify(manifestFor(program)), { 'Cache-Control': 'public, max-age=3600' });
        }
        if (p === '/favicon.ico') {
            if (sendFileIfThere(res, `assets/growth-brand/favicon/${program === 'crew' ? 'crew' : 'circle'}/favicon.ico`, 'image/x-icon', { 'Cache-Control': 'public, max-age=86400' })) return undefined;
            return send(res, 404, 'text/plain', 'not found');
        }

        if (isInvitePath) {
            if (program === 'crew') return redirect(res, hosts.origins.circle + p.replace(/\.html$/, '') + qs);
            return sendPage(req, res, PAGES.invite, 'circle');
        }
        if (p === '/' || p === '/index.html' || p === `/${program}` || p === `/${program}.html`) return sendPage(req, res, program === 'crew' ? PAGES.crew : PAGES.circle, program);
        if (p === '/circle' || p === '/circle.html') return redirect(res, hosts.programUrl('circle', '/') + qs);
        if (p === '/crew' || p === '/crew.html' || p === '/scouts' || p === '/scouts.html') return redirect(res, hosts.programUrl('scout', '/') + qs);

        // Everything else is the main site's business: /login, /signup, /marketplace, /terms, /admin ...
        return redirect(res, hosts.origins.main + p + qs);
    };
}

module.exports = { createHostRouter };
