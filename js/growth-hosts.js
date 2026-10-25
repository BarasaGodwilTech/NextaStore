/**
 * NextaHosts: where do Circle, Crew and the main NextaStore site live, and how do I link between them?
 *
 * The same logic as backend/src/growth/hosts.js (scripts/growth-hosts-test.js checks they agree).
 * Load it FIRST on every growth page (and on the seller dashboard if you use the invite widget):
 *
 *   <!--NEXTA_HOSTS-->                       the server fills this in with window.NEXTA_HOSTS = {...}
 *   <script src="/js/growth-config.js"></script>   optional: set window.NEXTA_HOSTS by hand
 *   <script src="/js/growth-hosts.js"></script>
 *
 * Without any configuration it still works:
 *   - on circle.<root> or crew.<root> it works out the main site from the address (<root>);
 *   - anywhere else it assumes "path" mode (/circle, /crew, /invite on the same host), which is how
 *     the program worked before subdomains, and is what you get on localhost.
 *
 *   NextaHosts.mode                'subdomain' | 'path'
 *   NextaHosts.kind                'main' | 'circle' | 'crew' | null   (which host this page is on)
 *   NextaHosts.main('/login')      address of a page on the main site
 *   NextaHosts.program('scout')    address of the Circle or Crew home
 *   NextaHosts.invite(code)        the link a partner shares
 *   NextaHosts.rewriteLinks(el)    makes root-relative <a href="/marketplace"> point at the main site
 *   NextaHosts.watch()             keeps doing that for links added later (the account menu, for example)
 *   NextaHosts.create(cfg, loc)    build another resolver, e.g. from GET /api/growth/rules .hosts
 */
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.NextaHosts = api.create(root.NEXTA_HOSTS, root.location);
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    const strip = (s) => String(s || '').replace(/\/+$/, '');
    const hostOf = (o) => { try { return new URL(o).host.toLowerCase(); } catch (e) { return ''; } };

    function derive(loc) {
        if (!loc || !loc.hostname) return { mode: 'path' };
        const m = String(loc.hostname).toLowerCase().match(/^(?:circle|crew)\.(.+)$/);
        if (!m || !(m[1].includes('.') || m[1] === 'localhost')) return { mode: 'path' };
        const port = loc.port ? `:${loc.port}` : '';
        const base = `${loc.protocol}//`;
        return { mode: 'subdomain', main: `${base}${m[1]}${port}`, circle: `${base}circle.${m[1]}${port}`, crew: `${base}crew.${m[1]}${port}` };
    }

    function create(cfg, loc) {
        let c = cfg && cfg.mode === 'subdomain' && cfg.main && cfg.circle && (cfg.crew || cfg.scouts) ? { ...cfg, crew: cfg.crew || cfg.scouts } : derive(loc);
        const sub = c.mode === 'subdomain';
        const origins = sub ? { main: strip(c.main), circle: strip(c.circle), crew: strip(c.crew) } : { main: '', circle: '', crew: '' };
        const here = loc && loc.host ? String(loc.host).toLowerCase() : '';
        let kind = null;
        if (sub) for (const k of ['main', 'circle', 'crew']) if (hostOf(origins[k]) === here) kind = k;

        const PATHS = { circle: '/circle', crew: '/crew' };
        const isProgramHost = sub && (kind === 'circle' || kind === 'crew');
        const withSlash = (p) => (String(p || '/').startsWith('/') ? String(p || '/') : `/${p}`);

        const main = (path) => (sub ? origins.main : '') + withSlash(path);
        function program(which, path) {
            const key = which === 'scout' || which === 'scouts' || which === 'crew' ? 'crew' : 'circle';
            const p = withSlash(path);
            if (sub) return origins[key] + p;
            return PATHS[key] + (p === '/' ? '' : p);
        }
        function invite(code) {
            const cc = String(code || '').toUpperCase();
            if (sub) return `${origins.circle}/i/${encodeURIComponent(cc)}`;
            return `${loc && loc.origin ? loc.origin : ''}/invite?ref=${encodeURIComponent(cc)}`;
        }

        /** Where a root-relative address ("/marketplace") belongs. Returns the address unchanged when it is already right. */
        function resolve(href) {
            if (!sub || typeof href !== 'string' || !href.startsWith('/') || href.startsWith('//')) return href;
            const path = href.split(/[?#]/)[0];
            const stem = path.replace(/\.html$/, '');   // an old-style address ending in .html is the same page as the clean one
            if (stem === '/circle') return origins.circle + '/' + href.slice(path.length).replace(/^\//, '');
            if (stem === '/crew' || stem === '/scouts') return origins.crew + '/' + href.slice(path.length).replace(/^\//, '');
            if (stem === '/invite' || path.startsWith('/i/')) return origins.circle + href;
            if (isProgramHost) {
                // On a program host the program's own assets and home stay local; every other page is the main site.
                if (stem === '/' || stem === '/index' || path.startsWith('/css/') || path.startsWith('/js/') || path.startsWith('/assets/') || path.startsWith('/api/')) return href;
                return origins.main + href;
            }
            return href;
        }

        function rewriteLinks(el) {
            if (!sub || !el || !el.querySelectorAll) return;
            el.querySelectorAll('a[href^="/"]:not([data-local])').forEach((a) => {
                const raw = a.getAttribute('href'); const next = resolve(raw);
                if (next !== raw) a.setAttribute('href', next);
            });
        }
        let observer = null;
        function watch(doc) {
            const d = doc || (typeof document !== 'undefined' ? document : null);
            if (!sub || !d || observer || typeof MutationObserver === 'undefined') return;
            const run = () => { rewriteLinks(d); observer = new MutationObserver(() => rewriteLinks(d)); observer.observe(d.documentElement, { childList: true, subtree: true }); };
            if (d.readyState === 'loading') d.addEventListener('DOMContentLoaded', run, { once: true }); else run();
        }

        return { mode: sub ? 'subdomain' : 'path', origins, kind, isProgramHost, main, program, invite, resolve, rewriteLinks, watch, publicConfig: () => ({ mode: sub ? 'subdomain' : 'path', ...origins }), create };
    }

    return { create, derive };
});
