const express = require('express');
const prisma = require('../prisma');
const config = require('../config');
const cache = require('../cache');
const { slugify } = require('../utils');
const { isStoreCurrentlyActive, getActivePaymentMethods } = require('../helpers');
const seo = require('../seo');

const router = express.Router();

const PAGE_TTL_SECONDS = 60;      // a seller's edit shows up within a minute
const SITEMAP_TTL_SECONDS = 3600;

// The API-wide helmet() CSP is `default-src 'self'`, which would block the
// store's R2-hosted images and this page's inline stylesheet. These pages
// are static HTML with no scripts (JSON-LD is data, not executable), so
// allow images/styles but nothing else.
const PAGE_CSP = "default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function sendHtml(res, status, html, { cacheable }) {
    res.status(status);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Security-Policy', PAGE_CSP);
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

router.get('/s/:slug', async (req, res, next) => {
    try {
        const slug = slugify(req.params.slug);
        // One URL per store: /s/My-Store and /s/my-store/ collapse to the canonical form.
        if (slug !== req.params.slug) return res.redirect(301, `/s/${encodeURIComponent(slug)}`);

        const cacheKey = `seo:store:${slug}`;
        const cached = await cache.get(cacheKey).catch(() => null);
        if (cached) return sendHtml(res, 200, cached, { cacheable: true });

        const store = await prisma.store.findFirst({ where: { slug, deletedAt: null, isPublished: true } });
        // Same visibility rule as GET /store/public: drafts and lapsed
        // (no trial / no active subscription) stores are not public. Unlike
        // that route there is no "owner preview" exception — this page is
        // cached and served to crawlers, so it must be identical for everyone.
        if (!store || !isStoreCurrentlyActive(store)) {
            return sendHtml(res, 404, seo.renderNotFoundPage({ appUrl: config.frontendUrl }), { cacheable: false });
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

        const html = seo.renderStorePage({
            store, products, productCount, paymentLabels,
            siteUrl: config.siteUrl, appUrl: config.frontendUrl
        });
        await cache.set(cacheKey, html, PAGE_TTL_SECONDS).catch(() => {});
        sendHtml(res, 200, html, { cacheable: true });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
