const cache = require('./cache');

// Caches a successful (200) JSON GET response for `ttlSeconds`, keyed on the
// full request URL (path + query string), so different pages/filters/sorts
// get separate entries automatically.
//
// IMPORTANT — only use this on routes whose *body* is identical for every
// caller. Some "public" routes in this app branch on req.user (an owner
// previewing their own unpublished store sees it; anyone else gets 404) —
// caching one of those would either leak a draft store to a stranger or
// serve the owner a stale 404 depending on who happened to populate the
// cache first. Route-by-route: /products/public, /products/deals,
// /store/public/all and /store/search have no such branch and are safe;
// /store/public and /store/public/:idOrSlug do and must NOT get this
// middleware.
//
// Session-renewal (the X-Session-Token header set by attachRenewedToken in
// middleware.js) is unaffected either way: it's set on `res` by the auth
// middleware that runs before this one, so it goes out with every response,
// cached or not — only the JSON body itself is what gets reused.
function cacheResponse(ttlSeconds) {
    return function (req, res, next) {
        const key = `route-cache:${req.originalUrl}`;
        cache.get(key)
            .then((cached) => {
                if (cached) {
                    res.setHeader('X-Cache', 'HIT');
                    return res.json(JSON.parse(cached));
                }
                const originalJson = res.json.bind(res);
                res.json = (body) => {
                    res.setHeader('X-Cache', 'MISS');
                    if (res.statusCode === 200) {
                        cache.set(key, JSON.stringify(body), ttlSeconds);
                    }
                    return originalJson(body);
                };
                next();
            })
            .catch(() => next()); // a cache read failure should never block the request
    };
}

module.exports = { cacheResponse };
