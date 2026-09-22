const express = require('express');
const prisma = require('../prisma');
const { apiError } = require('../utils');
const { serializeProduct } = require('../helpers');
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
            product: { deletedAt: null, store: { deletedAt: null, isPublished: true } }
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
        const product = await prisma.product.findFirst({ where: { id: req.params.productId, deletedAt: null }, select: { id: true } });
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
