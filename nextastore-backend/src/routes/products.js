const express = require('express');
const crypto = require('crypto');
const prisma = require('../prisma');
const { apiError, saveImagePairsIfDataUrls, deleteImagesNotIn } = require('../utils');
const { getStoreForUser, resolveContextStore, serializeProduct, computeOnSale, createNotification, notifyStoreFollowersOfNewProduct } = require('../helpers');
const { requireAuth, requireSeller, optionalAuth } = require('../middleware');
const { validateBody, productSchema, productUpdateSchema } = require('../validation');
const { cacheResponse } = require('../cacheMiddleware');

const LOW_STOCK_THRESHOLD = 3;

const router = express.Router();

router.get('/deals', cacheResponse(30), async (req, res, next) => {
    try {
        // Filters on the indexed onSale column directly (see schema.prisma)
        // instead of pulling a working set and filtering/slicing in JS —
        // that older approach could silently return fewer than 8 deals once
        // discounted products fell outside whatever top-N it happened to
        // pull, and did a full row-by-row JS scan on every request.
        const products = await prisma.product.findMany({
            // Draft stores (setup not launched) never surface here either.
            where: { onSale: true, deletedAt: null, store: { deletedAt: null, isPublished: true } },
            include: { store: true },
            orderBy: { sold: 'desc' },
            take: 8
        });
        const list = products
            .map(p => ({
                ...serializeProduct(p),
                discount: Math.round((1 - Number(p.price) / Number(p.originalPrice)) * 100),
                storeName: p.store ? p.store.name : 'NextaStore Seller',
                storeSlug: p.store ? p.store.slug : null,
                store: undefined
            }));
        res.json({ data: list });
    } catch (err) {
        next(err);
    }
});

router.get('/top', requireAuth, requireSeller, async (req, res, next) => {
    try {
        const store = await getStoreForUser(req.user.id);
        if (!store) return res.json({ data: [] });
        const list = await prisma.product.findMany({
            where: { storeId: store.id, deletedAt: null },
            orderBy: { sold: 'desc' },
            take: 5
        });
        res.json({ data: list.map(serializeProduct) });
    } catch (err) {
        next(err);
    }
});

// Single product for a customer viewing the public product-detail page — no
// login required, and not restricted to "your own store" the way GET /:id
// below is. This route did not exist before: the customer-facing product
// page called the owner-only GET /:id endpoint, which rejected every
// logged-out visitor with 401 and rejected logged-in visitors too unless
// the product happened to belong to their own store. In practice, no real
// shopper could ever open a product page.
// Marketplace-wide product listing (across every store), for the
// marketplace page's browse/search grid. This did not exist before —
// the marketplace was reusing GET /products/deals (max 8 discounted
// items) as its entire product catalog, so "Trending Products" and the
// marketplace search box could only ever see whichever handful of
// products happened to be on a discount. This mirrors the store-scoped
// GET / below (same query params/shape) but searches across all stores
// instead of one, same as GET /store/public/all does for stores.
// Cached for 30s: identical for every visitor regardless of query params
// (the only per-request thing optionalAuth adds is the X-Session-Token
// renewal header, which is set before this middleware runs and isn't part
// of the cached body — see cacheMiddleware.js).
router.get('/public', optionalAuth, cacheResponse(30), async (req, res, next) => {
    try {
        const page = Math.max(1, Number(req.query.page) || 1);
        const limit = Math.min(60, Math.max(1, Number(req.query.limit) || 60));
        const q = String(req.query.q || '').trim();
        const category = String(req.query.category || '').trim();
        const minPrice = Number(req.query.minPrice);
        const maxPrice = Number(req.query.maxPrice);
        const sort = String(req.query.sort || 'popular');

        const where = {
            deletedAt: null,
            // Draft stores never appear in the marketplace-wide product grid.
            store: { deletedAt: null, isPublished: true },
            ...(q ? { name: { contains: q, mode: 'insensitive' } } : {}),
            ...(category ? { category } : {}),
            ...(Number.isFinite(minPrice) ? { price: { gte: minPrice } } : {}),
            ...(Number.isFinite(maxPrice) ? { price: { ...(Number.isFinite(minPrice) ? { gte: minPrice } : {}), lte: maxPrice } } : {})
        };

        const orderBy = sort === 'newest'
            ? [{ createdAt: 'desc' }]
            : sort === 'price-low'
                ? [{ price: 'asc' }, { createdAt: 'desc' }]
                : sort === 'price-high'
                    ? [{ price: 'desc' }, { createdAt: 'desc' }]
                    : [{ sold: 'desc' }, { createdAt: 'desc' }];

        const [list, total] = await Promise.all([
            prisma.product.findMany({
                where, orderBy, skip: (page - 1) * limit, take: limit,
                include: { store: { select: { id: true, slug: true, name: true } } }
            }),
            prisma.product.count({ where })
        ]);

        res.json({
            data: list.map(p => ({
                ...serializeProduct(p),
                storeName: p.store ? p.store.name : 'NextaStore Seller',
                storeSlug: p.store ? p.store.slug : null,
                store: undefined
            })),
            pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 }
        });
    } catch (err) {
        next(err);
    }
});

router.get('/public/:id', optionalAuth, async (req, res, next) => {
    try {
        const product = await prisma.product.findFirst({
            where: { id: req.params.id, deletedAt: null, store: { deletedAt: null, isPublished: true } }
        });
        if (!product) throw apiError('Product not found.', 404);
        res.json({ data: serializeProduct(product) });
    } catch (err) {
        next(err);
    }
});

router.get('/', optionalAuth, async (req, res, next) => {
    try {
        const store = await resolveContextStore(req);
        if (!store) throw apiError('Store not found.', 404);

        const page = Math.max(1, Number(req.query.page) || 1);
        const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 24));
        const q = String(req.query.q || '').trim();
        const category = String(req.query.category || '').trim();
        const minPrice = Number(req.query.minPrice);
        const maxPrice = Number(req.query.maxPrice);
        const sort = String(req.query.sort || 'newest');

        const where = {
            storeId: store.id,
            deletedAt: null,
            ...(q ? { name: { contains: q, mode: 'insensitive' } } : {}),
            ...(category ? { category } : {}),
            ...(Number.isFinite(minPrice) ? { price: { gte: minPrice } } : {}),
            ...(Number.isFinite(maxPrice) ? { price: { ...(Number.isFinite(minPrice) ? { gte: minPrice } : {}), lte: maxPrice } } : {})
        };

        const orderBy = sort === 'popular'
            ? [{ sold: 'desc' }, { createdAt: 'desc' }]
            : sort === 'price-low'
                ? [{ price: 'asc' }, { createdAt: 'desc' }]
                : sort === 'price-high'
                    ? [{ price: 'desc' }, { createdAt: 'desc' }]
                    : [{ createdAt: 'desc' }];

        const [list, total] = await Promise.all([
            prisma.product.findMany({ where, orderBy, skip: (page - 1) * limit, take: limit }),
            prisma.product.count({ where })
        ]);
        res.json({
            data: list.map(serializeProduct),
            pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 }
        });
    } catch (err) {
        next(err);
    }
});

router.get('/:id', requireAuth, requireSeller, async (req, res, next) => {
    try {
        const store = await getStoreForUser(req.user.id);
        const product = await prisma.product.findUnique({ where: { id: req.params.id } });
        if (!product || !store || product.storeId !== store.id || product.deletedAt) {
            throw apiError('Product not found.', 404);
        }
        res.json({ data: serializeProduct(product) });
    } catch (err) {
        next(err);
    }
});

router.post('/', requireAuth, requireSeller, validateBody(productSchema), async (req, res, next) => {
    try {
        const store = await getStoreForUser(req.user.id);
        if (!store) throw apiError('No store found for this account.', 404);

        const payload = req.body;
        // Generated up front (rather than letting Prisma's @default(cuid())
        // assign one on insert) so uploaded images can go straight into
        // this product's own folder — uploads/products/<id>/... — instead
        // of the old flat "uploads/" prefix shared by every image on the
        // whole marketplace. A plain string primary key accepts this fine;
        // nothing else assumes the id is in cuid's own format.
        const productId = crypto.randomUUID();
        const { images, thumbnails } = await saveImagePairsIfDataUrls(payload.images, payload.thumbnails, `products/${productId}`);

        const product = await prisma.product.create({
            data: {
                id: productId,
                storeId: store.id,
                name: payload.name,
                description: payload.description,
                price: payload.price,
                originalPrice: payload.originalPrice ?? null,
                onSale: computeOnSale(payload.price, payload.originalPrice ?? null),
                category: payload.category,
                images,
                thumbnails,
                image: images[0] || null,
                icon: payload.icon,
                stock: payload.stock
            }
        });
        res.status(201).json({ data: serializeProduct(product) });

        // Deliberately not awaited, same reasoning as notifyNewMessage in
        // routes/messages.js: it already swallows its own errors, and a
        // store with a large following must not add latency to the
        // seller's own "product created" response while it fans out.
        notifyStoreFollowersOfNewProduct({
            storeId: store.id,
            storeName: store.name,
            storeSlug: store.slug,
            storeOwnerId: store.ownerId,
            productId: product.id,
            productName: product.name
        });
    } catch (err) {
        next(err);
    }
});

router.put('/:id', requireAuth, requireSeller, validateBody(productUpdateSchema), async (req, res, next) => {
    try {
        const store = await getStoreForUser(req.user.id);
        const existing = await prisma.product.findUnique({ where: { id: req.params.id } });
        if (!existing || !store || existing.storeId !== store.id || existing.deletedAt) {
            throw apiError('Product not found.', 404);
        }

        const payload = req.body;
        const data = { ...payload };

        // productUpdateSchema is a .partial() — either field may be absent
        // from this request, so recompute onSale from whichever one changed
        // plus whatever the existing row already has for the other, not
        // from the payload alone (that would wrongly treat "price only"
        // edits as clearing the discount).
        if (data.price !== undefined || data.originalPrice !== undefined) {
            const nextPrice = data.price !== undefined ? data.price : existing.price;
            const nextOriginalPrice = data.originalPrice !== undefined ? data.originalPrice : existing.originalPrice;
            data.onSale = computeOnSale(nextPrice, nextOriginalPrice);
        }

        if (data.images !== undefined) {
            const saved = await saveImagePairsIfDataUrls(data.images, data.thumbnails, `products/${existing.id}`);
            data.images = saved.images;
            data.thumbnails = saved.thumbnails;
            data.image = data.images[0] || null;
        }

        const product = await prisma.product.update({ where: { id: existing.id }, data });

        // Clean up any old photo/thumbnail that's no longer part of this
        // product (removed or swapped out) now that the edit is saved —
        // best-effort, never blocks the response.
        if (data.images !== undefined) {
            await deleteImagesNotIn(existing.images, data.images);
            await deleteImagesNotIn(existing.thumbnails, data.thumbnails);
        }

        // Low-stock notification (item 12) for manual stock edits — the
        // checkout-driven decrement in orders.js has its own copy of this
        // check right after it decrements, since that path never goes
        // through this route.
        if (data.stock !== undefined && existing.stock > LOW_STOCK_THRESHOLD && product.stock <= LOW_STOCK_THRESHOLD && product.stock > 0 && store.ownerId) {
            await createNotification({
                userId: store.ownerId,
                type: 'low_stock',
                title: `Low stock: ${product.name}`,
                body: `Only ${product.stock} left.`,
                link: `dashboard.html#products`
            });
        }

        res.json({ data: serializeProduct(product) });
    } catch (err) {
        next(err);
    }
});

router.delete('/:id', requireAuth, requireSeller, async (req, res, next) => {
    try {
        const store = await getStoreForUser(req.user.id);
        const existing = await prisma.product.findUnique({ where: { id: req.params.id } });
        if (!existing || !store || existing.storeId !== store.id || existing.deletedAt) {
            throw apiError('Product not found.', 404);
        }

        // Soft delete: any past order referencing this product must keep
        // showing what was actually bought, so we never hard-delete a
        // product that has order history.
        await prisma.product.update({ where: { id: existing.id }, data: { deletedAt: new Date() } });
        res.json({ data: { id: existing.id } });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
