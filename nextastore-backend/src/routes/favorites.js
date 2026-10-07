const express = require('express');
const prisma = require('../prisma');
const { apiError } = require('../utils');
const { serializeProduct, storefrontVisibleWhere } = require('../helpers');
const { requireAuth, optionalAuth } = require('../middleware');

const router = express.Router();

// A buyer's saved/"liked" products list — same real-persistence pattern as
// StoreFollow (routes/store.js's /follow/:storeId), just for products
// instead of stores. Product favoriting previously only toggled a heart
// icon in the browser tab with no storage behind it at all, so it vanished
// on refresh and had nowhere to be viewed later; this is what backs the
// "My Favorites" page/link.

// List the current user's favorited products, most recently saved first.
// Products that were deleted or whose store was unpublished since being
// favorited are quietly skipped rather than erroring the whole list.
router.get('/', requireAuth, async (req, res, next) => {
    try {
        const page = Math.max(1, Number(req.query.page) || 1);
        const limit = Math.min(60, Math.max(1, Number(req.query.limit) || 24));

        const where = {
            userId: req.user.id,
            // Open stores only: a favorite whose store lapsed drops off the list
            // (the heart is kept, and it returns with the store).
            product: { deletedAt: null, store: storefrontVisibleWhere() }
        };

        const [rows, total] = await Promise.all([
            prisma.productFavorite.findMany({
                where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit,
                include: { product: { include: { store: { select: { id: true, slug: true, name: true } } } } }
            }),
            prisma.productFavorite.count({ where })
        ]);

        res.json({
            data: rows.map(r => ({
                ...serializeProduct(r.product),
                storeName: r.product.store ? r.product.store.name : 'NextaStore Seller',
                storeSlug: r.product.store ? r.product.store.slug : null,
                store: undefined,
                favoritedAt: r.createdAt
            })),
            pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 }
        });
    } catch (err) { next(err); }
});

// Which of a page of products the viewer has favorited, in ONE query:
// GET /favorites/check?ids=a,b,c  ->  { data: { favorited: ['a', 'c'] } }.
// The storefront paints every card's heart from this instead of asking
// GET /favorites/:productId once per card (24 requests a page). Must be
// declared BEFORE '/:productId' or "check" would be read as a product id.
// Signed-out viewers get an empty list, like the single lookup's `false`.
// Capped at 60 ids (the list endpoint's own page limit); extras are ignored.
router.get('/check', optionalAuth, async (req, res, next) => {
    try {
        const ids = [...new Set(String(req.query.ids || '').split(',').map(id => id.trim()).filter(id => id && id.length <= 64))].slice(0, 60);
        let favorited = [];
        if (req.user && ids.length) {
            const rows = await prisma.productFavorite.findMany({ where: { userId: req.user.id, productId: { in: ids } }, select: { productId: true } });
            favorited = rows.map(r => r.productId);
        }
        res.json({ data: { favorited } });
    } catch (err) { next(err); }
});

// Whether the current viewer (if logged in) has favorited a given product —
// used to set the heart icon's initial state on product-detail load.
router.get('/:productId', optionalAuth, async (req, res, next) => {
    try {
        const favorited = req.user
            ? !!(await prisma.productFavorite.findUnique({ where: { userId_productId: { userId: req.user.id, productId: req.params.productId } }, select: { id: true } }))
            : false;
        res.json({ data: { favorited } });
    } catch (err) { next(err); }
});

router.post('/:productId', requireAuth, async (req, res, next) => {
    try {
        // Same visibility rule as browsing/search/product pages: a product
        // whose store is in draft or past its trial with no payment can't
        // be reached this way either, even by someone who already has the
        // raw product id from before the store went inactive.
        const product = await prisma.product.findFirst({
            where: { id: req.params.productId, deletedAt: null, store: storefrontVisibleWhere() },
            select: { id: true }
        });
        if (!product) throw apiError('Product not found.', 404);
        await prisma.productFavorite.upsert({
            where: { userId_productId: { userId: req.user.id, productId: product.id } },
            create: { userId: req.user.id, productId: product.id },
            update: {}
        });
        res.json({ data: { favorited: true } });
    } catch (err) { next(err); }
});

router.delete('/:productId', requireAuth, async (req, res, next) => {
    try {
        await prisma.productFavorite.deleteMany({ where: { userId: req.user.id, productId: req.params.productId } });
        res.json({ data: { favorited: false } });
    } catch (err) { next(err); }
});

module.exports = router;
