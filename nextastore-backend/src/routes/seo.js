const express = require('express');
const prisma = require('../prisma');
const config = require('../config');
const cache = require('../cache');
const { slugify, isReservedSlug } = require('../utils');
const { isStoreCurrentlyActive, getActivePaymentMethods } = require('../helpers');
const { loadStoreShell } = require('../storeShell');
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
        await cache.set(cacheKey, html, PAGE_TTL_SECONDS).catch(() => {});
        sendHtml(res, 200, html, { cacheable: true });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
