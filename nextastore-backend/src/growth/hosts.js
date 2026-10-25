/**
 * Where does everything live? One small, dependency-free module that answers that for the whole program.
 *
 *   mode "path"       (default)  Circle and Crew are pages on the main site: /circle, /crew, /invite.
 *                                Nothing to set up. This is how v1 to v3 worked, so nothing breaks.
 *   mode "subdomain"             circle.yourdomain.com and crew.yourdomain.com, plus the main site.
 *
 * Configure with environment variables (see .env.example in docs/03_INTEGRATION_GUIDE.md):
 *   GROWTH_MODE=subdomain
 *   GROWTH_ROOT_DOMAIN=nextastore.com        -> main https://nextastore.com, circle.nextastore.com, crew.nextastore.com
 *   (optional) MAIN_ORIGIN / CIRCLE_ORIGIN / CREW_ORIGIN to override any one of them (SCOUTS_ORIGIN still works as the old name), e.g.
 *   MAIN_ORIGIN=https://www.nextastore.com   or, for local work,   CIRCLE_ORIGIN=http://circle.localhost:4000
 *
 * The browser has the same logic in js/growth-hosts.js. scripts/growth-hosts-test.js checks both agree.
 */
'use strict';

const PROGRAM_PATH = { circle: '/circle', scout: '/crew' };
const CODE_RE = /^(CIRCLE|CREW|SCOUT)-[A-HJKMNP-Z2-9]{5}$/;   // SCOUT- is the pre-rename prefix: those codes keep working

const stripSlash = (s) => String(s || '').replace(/\/+$/, '');
const hostOf = (origin) => { try { return new URL(origin).host.toLowerCase(); } catch (err) { return ''; } };

function fromEnv(env = process.env) {
    return {
        mode: env.GROWTH_MODE,
        rootDomain: env.GROWTH_ROOT_DOMAIN,
        scheme: env.GROWTH_SCHEME,
        main: env.MAIN_ORIGIN,
        circle: env.CIRCLE_ORIGIN,
        crew: env.CREW_ORIGIN || env.SCOUTS_ORIGIN
    };
}

function createHosts(cfg = fromEnv()) {
    const mode = cfg.mode === 'subdomain' ? 'subdomain' : 'path';
    const scheme = cfg.scheme === 'http' ? 'http' : 'https';
    const root = String(cfg.rootDomain || '').trim().toLowerCase().replace(/^\.+|\.+$/g, '');
    const origins = { main: stripSlash(cfg.main), circle: stripSlash(cfg.circle), crew: stripSlash(cfg.crew || cfg.scouts) };

    if (mode === 'subdomain') {
        if (!root && !(origins.main && origins.circle && origins.crew)) {
            throw new Error('growth hosts: GROWTH_MODE=subdomain needs GROWTH_ROOT_DOMAIN (or all three of MAIN_ORIGIN, CIRCLE_ORIGIN, CREW_ORIGIN).');
        }
        if (root) {
            origins.main = origins.main || `${scheme}://${root}`;
            origins.circle = origins.circle || `${scheme}://circle.${root}`;
            origins.crew = origins.crew || `${scheme}://crew.${root}`;
        }
        for (const [k, v] of Object.entries(origins)) {
            if (!/^https?:\/\/[^/]+$/.test(v)) throw new Error(`growth hosts: ${k} origin "${v}" must look like https://host (no path).`);
        }
        if (new Set(Object.values(origins).map(hostOf)).size !== 3) throw new Error('growth hosts: main, circle and crew must be three different hosts.');
    }

    const hostToKind = new Map();
    if (mode === 'subdomain') for (const [k, v] of Object.entries(origins)) hostToKind.set(hostOf(v), k);

    /** 'main' | 'circle' | 'crew' | null for a Host header value (port included). */
    const kindOfHost = (hostHeader) => hostToKind.get(String(hostHeader || '').toLowerCase()) || null;
    const isAllowedOrigin = (origin) => mode === 'subdomain' && Object.values(origins).includes(stripSlash(origin));

    const programKey = (program) => (program === 'scout' || program === 'scouts' || program === 'crew' ? 'crew' : 'circle');
    const programOrigin = (program) => (mode === 'subdomain' ? origins[programKey(program)] : '');

    /** Link to a program's page. Absolute in subdomain mode, a root-relative path in path mode. */
    function programUrl(program, path = '/') {
        const p = path.startsWith('/') ? path : `/${path}`;
        if (mode === 'subdomain') return origins[programKey(program)] + p;
        const base = PROGRAM_PATH[programKey(program) === 'crew' ? 'scout' : 'circle'];
        return p === '/' ? base : base + p;
    }
    /** Link to a page that lives on the main site (login, signup, marketplace...). */
    const mainUrl = (path = '/') => (mode === 'subdomain' ? origins.main : '') + (path.startsWith('/') ? path : `/${path}`);

    /** The link a partner shares. One canonical host for invites: the Circle one. */
    function inviteUrl(code) {
        const c = String(code || '').toUpperCase();
        if (mode === 'subdomain') return `${origins.circle}/i/${encodeURIComponent(c)}`;
        return `/invite?ref=${encodeURIComponent(c)}`;
    }

    /**
     * A "come back to me" address is only trusted when it points at one of our own hosts, so the
     * session hand-off can never be used to send a visitor (or their sign-in) to someone else's site.
     * Returns an absolute URL string, or null.
     */
    function safeReturn(raw) {
        try {
            const u = new URL(String(raw), origins.main || 'http://invalid.invalid');
            if (mode !== 'subdomain') return null;
            if (!isAllowedOrigin(u.origin)) return null;
            if (u.username || u.password) return null;
            return u.toString();
        } catch (err) { return null; }
    }

    const publicConfig = () => ({ mode, main: origins.main, circle: origins.circle, crew: origins.crew });

    return { mode, origins, kindOfHost, isAllowedOrigin, programOrigin, programUrl, mainUrl, inviteUrl, safeReturn, publicConfig, PROGRAM_PATH, CODE_RE };
}

module.exports = { createHosts, fromEnv };
