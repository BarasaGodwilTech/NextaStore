const express = require('express');
const prisma = require('../prisma');
const config = require('../config');
const cache = require('../cache');
const { slugify, isReservedSlug } = require('../utils');
const { productPath, productKeyFromSlug } = require('../slugs');
const { isStoreCurrentlyActive, getActivePaymentMethods } = require('../helpers');
const { loadStoreShell, loadProductShell } = require('../storeShell');
const seo = require('../seo');

const router = express.Router();

const PAGE_TTL_SECONDS = 60;      // a seller's edit shows up within a minute
const SITEMAP_TTL_SECONDS = 3600;

/**
 * The browser-facing host is the source of truth for public SEO URLs. In
 * production this is the host on the reverse proxy; in local development the
 * http-server proxy preserves the original Host header. Forwarded headers are
 * preferred when a platform proxy supplies them.
 */
function requestSiteUrl(req) {
    const proto = String(req.get('x-forwarded-proto') || req.protocol || 'http')
        .split(',')[0].trim();
    const host = String(req.get('x-forwarded-host') || req.get('host') || '').split(',')[0].trim();
    if (/^https?$/.test(proto) && /^[A-Za-z0-9.-]+(?::\d+)?$/.test(host)) {
        return `${proto}://${host}`;
    }
    return config.siteUrl;
}

function sendHtml(res, status, html, { cacheable }) {
    res.status(status);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    // The API-wide helmet() policy is `default-src 'self'`, built for JSON. This
    // response is the normal storefront page, which loads its icon font, map
    // library and images from other hosts and runs its own scripts - exactly what
    // the same file does when the static site serves it - so that policy (and the
    // same-origin-only resource policy) would break it.
    res.removeHeader('Content-Security-Policy');
    res.removeHeader('Cross-Origin-Resource-Policy');
    // helmet() defaults to `Referrer-Policy: no-referrer`. That is right for JSON,
    // but this page draws OpenStreetMap tiles, and OSM refuses any tile request
    // that arrives without a Referer ("Access blocked" image). Send the origin
    // only, and only cross-origin - never a full URL.
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    // Nothing on a storefront needs camera/mic/etc.; say so explicitly.
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', cacheable ? `public, max-age=${PAGE_TTL_SECONDS}, s-maxage=${PAGE_TTL_SECONDS}` : 'no-store');
    res.send(html);
}

router.get('/robots.txt', (req, res) => {
    const siteUrl = requestSiteUrl(req);
    res.type('text/plain').set('Cache-Control', 'public, max-age=3600').send(seo.renderRobots({ siteUrl }));
});

router.get('/sitemap.xml', async (req, res, next) => {
    try {
        const siteUrl = requestSiteUrl(req);
        const key = `seo:sitemap:${siteUrl}`;
        let xml = await cache.get(key).catch(() => null);
        if (!xml) {
            const rows = await prisma.store.findMany({
                where: { deletedAt: null, isPublished: true },
                select: { slug: true, updatedAt: true, seo: true, trialEndsAt: true, subscriptionPaidUntil: true },
                orderBy: { updatedAt: 'desc' },
                take: seo.SITEMAP_MAX_URLS
            });
            const listed = rows.filter(s => isStoreCurrentlyActive(s) && seo.isIndexable(s));
            xml = seo.renderSitemap({ siteUrl, appUrl: siteUrl, stores: listed });
            await cache.set(key, xml, SITEMAP_TTL_SECONDS).catch(() => {});
        }
        res.type('application/xml').set('Cache-Control', `public, max-age=${SITEMAP_TTL_SECONDS}`).send(xml);
    } catch (err) {
        next(err);
    }
});

// Links shared before stores moved to the bare address (nextastores.com/s/<slug>)
// keep working: send them to the new one.
router.get('/s/:slug', (req, res) => {
    res.redirect(301, `/${encodeURIComponent(slugify(req.params.slug))}`);
});

// The query string of the request, for redirects that must keep it (a throwaway
// ?x=2 is how a link preview is re-tested, see README).
function queryOf(req) {
    const url = req.originalUrl || '';
    return url.includes('?') ? url.slice(url.indexOf('?')) : '';
}

// Where a product's id alone leads when no clean address can be made (a store
// with no usable slug, or an id too short to key on): the static product page,
// which works on the id.
function legacyProductUrl(id, storeSlug) {
    return `/product-detail?id=${encodeURIComponent(id)}${storeSlug ? `&store=${encodeURIComponent(storeSlug)}` : ''}`;
}

// A product by its id alone: nextastores.com/p/<productId>.
//
// A product's real address is /<store-slug>/<name>-<key> (below). This is the
// short form for places that only know the id (a product shared inside a chat,
// a link made by hand, anything from before product addresses existed): it
// sends the visitor on, permanently, to the real address - where the preview
// tags live - and keeps any query string. Two path segments, so it can never
// collide with a store's /<slug>; 'p' is a reserved word, and this is registered
// before that catch-all, which must stay last.
router.get('/p/:productId', async (req, res, next) => {
    try {
        const id = req.params.productId;
        const siteUrl = requestSiteUrl(req);

        const notFound = async () => {
            const shell = await loadProductShell();
            if (!shell) return next();
            return sendHtml(res, 404, seo.renderProductShell(shell, { siteUrl, appUrl: siteUrl }), { cacheable: false });
        };
        // A malformed id never reaches the database.
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return notFound();

        const product = await prisma.product.findFirst({
            where: { id, deletedAt: null, store: { deletedAt: null } },
            select: { id: true, name: true, store: { select: { slug: true } } }
        });
        if (!product || !product.store) return notFound();

        const clean = productPath(product, product.store.slug);
        if (!clean) return res.redirect(302, legacyProductUrl(product.id, product.store.slug));
        res.redirect(301, `${clean}${queryOf(req)}`);
    } catch (err) {
        next(err);
    }
});

// A product's public address: nextastores.com/<store-slug>/<name>-<key>.
//
// Serves the REAL product-detail.html with that product's own <head> (title with
// the price, photo, description, canonical URL, JSON-LD), exactly as /<slug> does
// for stores - so the address in the browser is also the address that previews
// properly in WhatsApp, Facebook and the rest. The page learns which product it
// is from two <meta> tags in that <head>, since the address only holds a short key.
//
// The key is the tail of the product's id, looked up inside the named store, so
// the readable name can change (a rename, a hand-edited link) and the address
// still finds the product and 301s to the current spelling. Same privacy rule as
// a store: a draft / lapsed store's product gets generic tags only; an unknown
// one gets the page with a real 404. Steps aside for reserved first words (css,
// api, errors...), so static folders and the API are never shadowed.
router.get('/:storeSlug/:productSlug', async (req, res, next) => {
    try {
        const rawStore = req.params.storeSlug;
        const rawProduct = req.params.productSlug;
        if (!/^[A-Za-z0-9-]+$/.test(rawStore) || !/^[A-Za-z0-9-]+$/.test(rawProduct)) return next();
        const storeKey = slugify(rawStore);
        if (isReservedSlug(storeKey)) return next();
        const key = productKeyFromSlug(rawProduct);
        if (!key) return next();

        const siteUrl = requestSiteUrl(req);
        const query = queryOf(req);
        const cacheKey = `seo:product-page:${siteUrl}:${storeKey}:${key}`;
        let entry = null;
        try { entry = JSON.parse(await cache.get(cacheKey)); } catch (e) { entry = null; }
        if (entry && entry.path && entry.html) {
            if (req.path !== entry.path) return res.redirect(301, `${entry.path}${query}`);
            return sendHtml(res, 200, entry.html, { cacheable: true });
        }

        const shell = await loadProductShell();
        const product = await prisma.product.findFirst({
            where: {
                deletedAt: null,
                id: { endsWith: key, mode: 'insensitive' },
                store: { deletedAt: null, OR: [{ slug: storeKey }, { id: rawStore }] }
            },
            select: {
                id: true, name: true, description: true, price: true, stock: true,
                image: true, images: true, thumbnails: true,
                store: { select: { id: true, slug: true, name: true, logo: true, district: true, seo: true, isPublished: true, deletedAt: true, trialEndsAt: true, subscriptionPaidUntil: true } }
            }
        });
        const store = product && product.store;

        // Unknown address: still the normal page (which shows its own "product
        // not found" state) but with a real 404 so nothing lingers in a cache.
        // (The query already excludes deleted stores; this is the second lock.)
        if (!product || !store || store.deletedAt) {
            if (!shell) return next();
            return sendHtml(res, 404, seo.renderProductShell(shell, { siteUrl, appUrl: siteUrl }), { cacheable: false });
        }

        // One address per product: a different spelling of the name, the store's
        // id instead of its slug, capitals or a trailing slash all collapse to it.
        const clean = productPath(product, store.slug);
        if (clean && req.path !== clean) return res.redirect(301, `${clean}${query}`);
        // No usable clean address (cannot happen for real ids): the static page.
        if (!clean) return res.redirect(302, legacyProductUrl(product.id, store.slug));

        if (!shell) {
            // Can't read the page itself; the site's own copy still works.
            return res.redirect(302, `${config.frontendUrl.replace(/\/$/, '')}${legacyProductUrl(product.id, store.slug).replace('/product-detail', '/product-detail.html')}`);
        }

        // Not public (draft, or trial / paid time over): the page is identical for
        // everyone, so nothing product-specific goes into it; the owner still
        // gets through because the page asks the API, which knows who is looking.
        const live = store.isPublished && isStoreCurrentlyActive(store);
        if (!live) {
            return sendHtml(res, 200, seo.renderProductShell(shell, { product, store, siteUrl, appUrl: siteUrl }), { cacheable: false });
        }

        const share = seo.buildProductShare({ product, store, siteUrl, appUrl: siteUrl });
        const html = seo.renderProductShell(shell, { share, product, store, siteUrl, appUrl: siteUrl });
        // Never keep a live page past the moment the store's time ends.
        const endsAt = Math.max(store.trialEndsAt ? new Date(store.trialEndsAt).getTime() : 0, store.subscriptionPaidUntil ? new Date(store.subscriptionPaidUntil).getTime() : 0);
        const secondsLeft = Math.floor((endsAt - Date.now()) / 1000);
        const ttl = Math.max(1, Math.min(PAGE_TTL_SECONDS, secondsLeft));
        await cache.set(cacheKey, JSON.stringify({ path: clean, html }), ttl).catch(() => {});
        sendHtml(res, 200, html, { cacheable: ttl >= PAGE_TTL_SECONDS });
    } catch (err) {
        next(err);
    }
});

// A store's public address: nextastores.com/<slug>.
//
// This must stay the LAST route on the app. It only ever answers a single
// path segment made of letters, digits and hyphens (so /css/main.css,
// /api/health and /favicon.ico never match) and steps aside for every
// reserved word (login, cart, api, ...). Real files win before a request gets
// here: the static host serves them first and only forwards what it has no
// file for (see README "Store links").
router.get('/:slug', async (req, res, next) => {
    try {
        const raw = req.params.slug;
        if (!/^[A-Za-z0-9-]+$/.test(raw)) return next();
        const slug = slugify(raw);
        if (isReservedSlug(slug)) return next();

        // One URL per store: /My-Store and /my-store/ collapse to /my-store.
        const query = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
        if (req.path !== `/${slug}`) return res.redirect(301, `/${encodeURIComponent(slug)}${query}`);

        const shell = await loadStoreShell();
        if (!shell) {
            // Can't read the page itself; the site's own copy still works.
            return res.redirect(302, `${config.frontendUrl.replace(/\/$/, '')}/store-detail.html?store=${encodeURIComponent(slug)}`);
        }

        // Keep the storefront shell's relative asset paths relative to the
        // public page URL. Adding a <base> tag pointing at FRONTEND_URL here
        // made local /<slug> pages load CSS/JS from a stale tunnel/domain.
        // The reverse proxy already serves the page on the browser-facing host,
        // so no base tag is needed.
        const siteUrl = requestSiteUrl(req);
        const cacheKey = `seo:store-page:${siteUrl}:${slug}`;
        const cached = await cache.get(cacheKey).catch(() => null);
        if (cached) return sendHtml(res, 200, cached, { cacheable: true });

        // Matches the slug, or - for a link built from a store id - the id, which
        // is then sent on to the store's real address.
        const store = await prisma.store.findFirst({ where: { deletedAt: null, OR: [{ slug }, { id: raw }] } });
        if (store && store.slug !== slug) return res.redirect(301, `/${encodeURIComponent(store.slug)}${query}`);
        // Unknown address: still the normal page (which shows its own "store not
        // found" state) but with a real 404 so search engines drop it.
        if (!store) {
            return sendHtml(res, 404, seo.renderStoreShell(shell, { siteUrl, appUrl: siteUrl }), { cacheable: false });
        }

        // Drafts and stores with no trial / subscription are not public. The
        // page is identical for everyone (it is cached and shown to crawlers),
        // so nothing store-specific goes into it; the owner still sees their
        // own store because the page asks the API, which knows who they are.
        const live = store.isPublished && isStoreCurrentlyActive(store);
        if (!live) {
            return sendHtml(res, 200, seo.renderStoreShell(shell, { store, live: false, siteUrl, appUrl: siteUrl }), { cacheable: false });
        }

        const [products, productCount, methods] = await Promise.all([
            prisma.product.findMany({
                where: { storeId: store.id, deletedAt: null },
                orderBy: [{ sold: 'desc' }, { createdAt: 'desc' }],
                take: 24,
                select: { id: true, name: true, description: true, price: true, category: true, stock: true, image: true, images: true, thumbnails: true }
            }),
            prisma.product.count({ where: { storeId: store.id, deletedAt: null } }),
            getActivePaymentMethods().catch(() => [])
        ]);
        const accepted = store.payments || {};
        const paymentLabels = methods.filter(m => accepted[m.code]).map(m => m.label);

        const html = seo.renderStoreShell(shell, {
            store, live: true, products, productCount, paymentLabels,
            siteUrl, appUrl: siteUrl
        });
        // Never keep a "live" page past the moment the store's trial / paid time
        // ends: otherwise a store that just lapsed keeps serving its old live
        // page (products and all) until the cache happens to expire.
        const endsAt = Math.max(store.trialEndsAt ? new Date(store.trialEndsAt).getTime() : 0, store.subscriptionPaidUntil ? new Date(store.subscriptionPaidUntil).getTime() : 0);
        const secondsLeft = Math.floor((endsAt - Date.now()) / 1000);
        const ttl = Math.max(1, Math.min(PAGE_TTL_SECONDS, secondsLeft));
        await cache.set(cacheKey, html, ttl).catch(() => {});
        sendHtml(res, 200, html, { cacheable: ttl >= PAGE_TTL_SECONDS });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
