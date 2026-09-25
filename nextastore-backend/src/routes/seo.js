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
    res.type('text/plain').set('Cache-Control', 'public, max-age=3600').send(seo.renderRobots({ siteUrl: config.siteUrl }));
});

router.get('/sitemap.xml', async (req, res, next) => {
    try {
        const key = 'seo:sitemap';
        let xml = await cache.get(key).catch(() => null);
        if (!xml) {
            const rows = await prisma.store.findMany({
                where: { deletedAt: null, isPublished: true },
                select: { slug: true, updatedAt: true, seo: true, trialEndsAt: true, subscriptionPaidUntil: true },
                orderBy: { updatedAt: 'desc' },
                take: seo.SITEMAP_MAX_URLS
            });
            const listed = rows.filter(s => isStoreCurrentlyActive(s) && seo.isIndexable(s));
            xml = seo.renderSitemap({ siteUrl: config.siteUrl, appUrl: config.frontendUrl, stores: listed });
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

        // Only needed when this API is opened on a different host than the site
        // (e.g. localhost:4000 while the site is on :3000): the page's relative
        // css/js paths would otherwise point at the API.
        let baseHref = null;
        try {
            const siteHost = new URL(config.frontendUrl).host;
            const reqHost = req.get('x-forwarded-host') || req.get('host');
            if (reqHost && reqHost !== siteHost) baseHref = config.frontendUrl;
        } catch (e) { /* malformed FRONTEND_URL: leave the page as is */ }

        const cacheKey = `seo:store-page:${slug}:${baseHref ? 'x' : 'l'}`;
        const cached = await cache.get(cacheKey).catch(() => null);
        if (cached) return sendHtml(res, 200, cached, { cacheable: true });

        // Matches the slug, or - for a link built from a store id - the id, which
        // is then sent on to the store's real address.
        const store = await prisma.store.findFirst({ where: { deletedAt: null, OR: [{ slug }, { id: raw }] } });
        if (store && store.slug !== slug) return res.redirect(301, `/${encodeURIComponent(store.slug)}${query}`);
        // Unknown address: still the normal page (which shows its own "store not
        // found" state) but with a real 404 so search engines drop it.
        if (!store) {
            return sendHtml(res, 404, seo.renderStoreShell(shell, { siteUrl: config.siteUrl, appUrl: config.frontendUrl, baseHref }), { cacheable: false });
        }

        // Drafts and stores with no trial / subscription are not public. The
        // page is identical for everyone (it is cached and shown to crawlers),
        // so nothing store-specific goes into it; the owner still sees their
        // own store because the page asks the API, which knows who they are.
        const live = store.isPublished && isStoreCurrentlyActive(store);
        if (!live) {
            return sendHtml(res, 200, seo.renderStoreShell(shell, { store, live: false, siteUrl: config.siteUrl, appUrl: config.frontendUrl, baseHref }), { cacheable: false });
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
            siteUrl: config.siteUrl, appUrl: config.frontendUrl, baseHref
        });
        await cache.set(cacheKey, html, PAGE_TTL_SECONDS).catch(() => {});
        sendHtml(res, 200, html, { cacheable: true });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
