/**
 * A minimal stand-in for Express' Router, so growth/routes.js can be loaded and served in the browser
 * test WITHOUT installing Express. Only what routes.js uses: Router() with get/post/put/delete,
 * path params, and a middleware chain with next(err).
 */
function Router() {
    const routes = [];
    const add = (method) => (p, ...handlers) => { routes.push({ method, path: p, handlers: handlers.flat() }); };
    return { routes, get: add('GET'), post: add('POST'), put: add('PUT'), delete: add('DELETE') };
}

function compile(p) {
    const keys = [];
    const re = new RegExp('^' + p.replace(/\/:([A-Za-z0-9_]+)/g, (_, k) => { keys.push(k); return '/([^/]+)'; }) + '/?$');
    return { re, keys };
}

/** Find the route for a method + path inside one router. Returns { route, params } or null. */
function match(router, method, pathname) {
    for (const route of router.routes) {
        if (route.method !== method) continue;
        const { re, keys } = compile(route.path);
        const m = re.exec(pathname);
        if (m) return { route, params: Object.fromEntries(keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
    }
    return null;
}

/** Run a route's handler chain against req/res, with Express-style next(err). */
function run(route, req, res) {
    return new Promise((resolve) => {
        let i = 0;
        const next = (err) => {
            if (err) { res.fail(err); return resolve(); }
            const h = route.handlers[i++];
            if (!h) return resolve();
            try { const r = h(req, res, next); if (r && typeof r.catch === 'function') r.catch((e) => { res.fail(e); resolve(); }); }
            catch (e) { res.fail(e); resolve(); }
        };
        res.done = resolve;
        next();
    });
}

module.exports = { Router, match, run };
