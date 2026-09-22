const express = require('express');
const prisma = require('../prisma');
const { apiError, saveImageIfDataUrl, slugify, deleteImageIfReplaced } = require('../utils');
const { getStoreForUser, resolveContextStore, serializeStore, serializePublicStore, serializeProduct, isStoreCurrentlyActive, maybeNotifySubscriptionReminder } = require('../helpers');
const { requireAuth, requireSeller, optionalAuth } = require('../middleware');
const { validateBody, updateStoreSchema } = require('../validation');
const { cacheResponse } = require('../cacheMiddleware');

const router = express.Router();

// Real store follow state/actions. A unique (user, store) row makes repeated
// follow clicks idempotent; the public counter is updated in the same transaction.
router.get('/follow/:storeId', optionalAuth, async (req, res, next) => {
    try {
        const store = await prisma.store.findFirst({ where: { id: req.params.storeId, deletedAt: null }, select: { id: true, followers: true } });
        if (!store) throw apiError('Store not found.', 404);
        const following = req.user
            ? !!(await prisma.storeFollow.findUnique({ where: { userId_storeId: { userId: req.user.id, storeId: store.id } }, select: { id: true } }))
            : false;
        res.json({ data: { following, followers: store.followers } });
    } catch (err) { next(err); }
});

router.post('/follow/:storeId', requireAuth, async (req, res, next) => {
    try {
        const store = await prisma.store.findFirst({ where: { id: req.params.storeId, deletedAt: null }, select: { id: true } });
        if (!store) throw apiError('Store not found.', 404);
        const result = await prisma.$transaction(async tx => {
            const existing = await tx.storeFollow.findUnique({ where: { userId_storeId: { userId: req.user.id, storeId: store.id } } });
            if (!existing) {
                await tx.storeFollow.create({ data: { userId: req.user.id, storeId: store.id } });
                await tx.store.update({ where: { id: store.id }, data: { followers: { increment: 1 } } });
            }
            return tx.store.findUnique({ where: { id: store.id }, select: { followers: true } });
        });
        res.json({ data: { following: true, followers: result.followers } });
    } catch (err) { next(err); }
});

router.delete('/follow/:storeId', requireAuth, async (req, res, next) => {
    try {
        const store = await prisma.store.findFirst({ where: { id: req.params.storeId, deletedAt: null }, select: { id: true } });
        if (!store) throw apiError('Store not found.', 404);
        const result = await prisma.$transaction(async tx => {
            const deleted = await tx.storeFollow.deleteMany({ where: { userId: req.user.id, storeId: store.id } });
            if (deleted.count) {
                await tx.store.update({ where: { id: store.id }, data: { followers: { decrement: 1 } } });
            }
            const current = await tx.store.findUnique({ where: { id: store.id }, select: { followers: true } });
            if (current && current.followers < 0) await tx.store.update({ where: { id: store.id }, data: { followers: 0 } });
            return Math.max(0, current?.followers || 0);
        });
        res.json({ data: { following: false, followers: result } });
    } catch (err) { next(err); }
});

// The current user's followed stores, most recently followed first — backs
// the "Following" page/link, same real-persistence pattern as GET /favorites
// for products. Registered as a literal '/follows' path, distinct from the
// '/follow/:storeId' routes above (different word, so there's no collision
// either way, but this sits after them to keep all the single-store follow
// actions grouped together first).
router.get('/follows', requireAuth, async (req, res, next) => {
    try {
        const page = Math.max(1, Number(req.query.page) || 1);
        const limit = Math.min(60, Math.max(1, Number(req.query.limit) || 24));

        const where = { userId: req.user.id, store: { deletedAt: null, isPublished: true } };

        const [rows, total] = await Promise.all([
            prisma.storeFollow.findMany({
                where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit,
                include: { store: true }
            }),
            prisma.storeFollow.count({ where })
        ]);

        const ids = rows.map(r => r.store.id);
        const counts = ids.length
            ? await prisma.product.groupBy({ by: ['storeId'], where: { storeId: { in: ids }, deletedAt: null }, _count: { _all: true } })
            : [];
        const countByStore = new Map(counts.map(c => [c.storeId, c._count._all]));

        res.json({
            data: rows.map(r => ({
                ...serializePublicStore(r.store, { productCount: countByStore.get(r.store.id) || 0 }),
                productCount: countByStore.get(r.store.id) || 0,
                followedAt: r.createdAt
            })),
            pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 }
        });
    } catch (err) { next(err); }
});

// Marketplace "browse all sellers" feed. Registered before /public/:idOrSlug
// so the literal path "all" is never swallowed by that param route.
//
// The frontend previously called this exact endpoint (js/marketplace.js)
// without it existing on the server at all — every request 404'd and the
// marketplace silently rendered an empty store grid. Implemented for real
// here, with a single grouped count query instead of one COUNT per store.
// Cached: no auth branch on this route, same body for everyone per query string.
router.get('/public/all', cacheResponse(30), async (req, res, next) => {
    try {
        const page = Math.max(1, Number(req.query.page) || 1);
        const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 12));
        const q = String(req.query.q || '').trim();
        const category = String(req.query.category || '').trim();
        const now = new Date();
        const where = {
            deletedAt: null,
            // Draft stores (setup not yet launched) never appear on the
            // public marketplace, regardless of trial/subscription status.
            isPublished: true,
            // Only stores currently within their trial or a paid period show
            // up on the public marketplace. Uses AND (not spreading a second
            // top-level OR) so this doesn't clobber the search OR above —
            // two OR keys on the same object would silently overwrite one.
            AND: [
                q ? {
                    OR: [
                        { name: { contains: q, mode: 'insensitive' } },
                        { description: { contains: q, mode: 'insensitive' } },
                        { district: { contains: q, mode: 'insensitive' } },
                        { address: { contains: q, mode: 'insensitive' } }
                    ]
                } : {},
                { OR: [{ trialEndsAt: { gt: now } }, { subscriptionPaidUntil: { gt: now } }] }
            ],
            ...(category && category !== 'all' ? { products: { some: { category, deletedAt: null } } } : {}),
        };
        const [stores, total] = await Promise.all([
            prisma.store.findMany({
                where,
                orderBy: { createdAt: 'desc' },
                skip: (page - 1) * limit,
                take: limit
            }),
            prisma.store.count({ where })
        ]);

        if (!stores.length) {
            return res.json({ data: [], pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 } });
        }

        const ids = stores.map(s => s.id);
        const [counts, categoryRows, completedRows] = await Promise.all([
            prisma.product.groupBy({
                by: ['storeId'],
                where: { storeId: { in: ids }, deletedAt: null },
                _count: { _all: true }
            }),
            prisma.product.groupBy({
                by: ['storeId', 'category'],
                where: { storeId: { in: ids }, deletedAt: null },
                _count: { _all: true }
            }),
            prisma.order.groupBy({
                by: ['storeId'],
                where: { storeId: { in: ids }, status: 'delivered', deletedAt: null },
                _count: { _all: true }
            })
        ]);

        const countByStore = new Map(counts.map(c => [c.storeId, c._count._all]));
        const completedByStore = new Map(completedRows.map(c => [c.storeId, c._count._all]));
        const categoriesByStore = new Map();
        categoryRows.forEach(row => {
            if (!categoriesByStore.has(row.storeId)) categoriesByStore.set(row.storeId, []);
            categoriesByStore.get(row.storeId).push(row.category);
        });

        res.json({
            data: stores.map(store => ({
                ...serializePublicStore(store, { productCount: countByStore.get(store.id) || 0 }),
                productCount: countByStore.get(store.id) || 0,
                completedOrderCount: completedByStore.get(store.id) || 0,
                categories: categoriesByStore.get(store.id) || []
            })),
            pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 }
        });
    } catch (err) {
        next(err);
    }
});

// Lightweight public search used by autocomplete/preview UIs. It returns only
// a small, bounded result set; full catalog pages use their own pagination.
// Cached: no auth branch on this route, same body for everyone per query string.
router.get('/search', cacheResponse(30), async (req, res, next) => {
    try {
        const q = String(req.query.q || '').trim();
        if (q.length < 2) return res.json({ data: { stores: [], products: [] } });
        const limit = Math.min(8, Math.max(1, Number(req.query.limit) || 6));
        const contains = { contains: q, mode: 'insensitive' };

        const [stores, products] = await Promise.all([
            prisma.store.findMany({
                // Draft stores never surface in search either.
                where: { deletedAt: null, isPublished: true, name: contains },
                select: { id: true, slug: true, name: true, logo: true, bannerColor: true, badgeCommitmentMonths: true, verified: true, subscriptionPaidUntil: true, trialEndsAt: true, description: true, district: true, address: true },
                orderBy: { createdAt: 'desc' },
                take: Math.min(4, limit)
            }),
            prisma.product.findMany({
                where: { deletedAt: null, name: contains, store: { deletedAt: null } },
                select: {
                    id: true, name: true, price: true,
                    thumbnails: true, image: true, store: { select: { id: true, slug: true, name: true } }
                },
                orderBy: { createdAt: 'desc' },
                take: limit
            })
        ]);

        res.json({
            data: {
                stores: stores.map(serializePublicStore),
                products: products.map(p => ({
                    ...serializeProduct(p),
                    store: undefined,
                    storeId: p.store?.id || null,
                    storeSlug: p.store?.slug || null,
                    storeName: p.store?.name || 'Seller'
                }))
            }
        });
    } catch (err) {
        next(err);
    }
});

// A specific seller's public storefront, looked up by either their id or
// their slug — different pages link to a store using whichever one they
// happen to have on hand (marketplace/product cards pass the id, the
// shareable "Store URL" in settings uses the slug), so this accepts both
// instead of forcing every caller to standardize on one.
//
// This route did not exist before: the frontend called
// `/store/public/${storeId}` from three different pages (marketplace,
// product detail, store detail) and every one of those requests 404'd,
// silently falling back to "the logged-in user's own store" (or nothing,
// for a logged-out visitor) instead of the seller the customer actually
// clicked on.
router.get('/public/:idOrSlug', optionalAuth, async (req, res, next) => {
    try {
        const { idOrSlug } = req.params;
        const store = await prisma.store.findFirst({
            where: { deletedAt: null, OR: [{ id: idOrSlug }, { slug: idOrSlug }] }
        });
        if (!store) throw apiError('Store not found.', 404);
        // A store still in draft (setup not launched yet) or past its trial
        // with no active subscription is hidden from everyone except its
        // own owner (who still needs to see it — to finish onboarding, or
        // to pay and reactivate it).
        if ((!store.isPublished || !isStoreCurrentlyActive(store)) && req.user?.id !== store.ownerId) {
            throw apiError('This store is not currently active.', 404);
        }
        const [productCount, completedOrderCount, categoryRows] = await Promise.all([
            prisma.product.count({ where: { storeId: store.id, deletedAt: null } }),
            prisma.order.count({ where: { storeId: store.id, status: 'delivered', deletedAt: null } }),
            prisma.product.groupBy({ by: ['category'], where: { storeId: store.id, deletedAt: null }, _count: { _all: true } })
        ]);
        res.json({ data: { ...serializePublicStore(store, { productCount }), productCount, completedOrderCount, categories: categoryRows.map(row => row.category) } });
    } catch (err) {
        next(err);
    }
});

router.get('/public', optionalAuth, async (req, res, next) => {
    try {
        const store = await resolveContextStore(req);
        if (!store) throw apiError('Store not found.', 404);
        if ((!store.isPublished || !isStoreCurrentlyActive(store)) && req.user?.id !== store.ownerId) {
            throw apiError('This store is not currently active.', 404);
        }
        const [productCount, completedOrderCount, categoryRows] = await Promise.all([
            prisma.product.count({ where: { storeId: store.id, deletedAt: null } }),
            prisma.order.count({ where: { storeId: store.id, status: 'delivered', deletedAt: null } }),
            prisma.product.groupBy({ by: ['category'], where: { storeId: store.id, deletedAt: null }, _count: { _all: true } })
        ]);
        res.json({ data: { ...serializePublicStore(store, { productCount }), productCount, completedOrderCount, categories: categoryRows.map(row => row.category) } });
    } catch (err) {
        next(err);
    }
});

router.get('/', requireAuth, requireSeller, async (req, res, next) => {
    try {
        const store = await getStoreForUser(req.user.id);
        if (!store) throw apiError('No store found for this account.', 404);
        // Fire-and-forget — never awaited so a reminder write/push never adds
        // latency to the dashboard's own store load. maybeNotifySubscriptionReminder
        // never throws, so there's nothing here to catch.
        maybeNotifySubscriptionReminder(store);
        res.json({ data: serializeStore(store) });
    } catch (err) {
        next(err);
    }
});

router.put('/', requireAuth, requireSeller, validateBody(updateStoreSchema), async (req, res, next) => {
    try {
        const store = await getStoreForUser(req.user.id);
        if (!store) throw apiError('No store found for this account.', 404);

        const payload = req.body;
        const data = { ...payload };
        delete data.id;
        delete data.ownerId;

        // Logo/banner replace their old R2 object instead of piling up a new
        // one every time a seller changes their branding — the old file is
        // deleted right after the new one is confirmed saved, so a failed
        // upload never leaves the store with neither image.
        if (data.logo !== undefined) {
            const oldLogo = store.logo;
            data.logo = await saveImageIfDataUrl(data.logo, `stores/${store.id}`);
            await deleteImageIfReplaced(oldLogo, data.logo);
        }
        if (data.banner !== undefined) {
            const oldBanner = store.banner;
            data.banner = await saveImageIfDataUrl(data.banner, `stores/${store.id}`);
            await deleteImageIfReplaced(oldBanner, data.banner);
        }
        if (data.payments !== undefined) data.payments = { ...store.payments, ...data.payments };
        if (data.seo !== undefined) data.seo = { ...store.seo, ...data.seo };

        if (data.slug !== undefined) {
            const newSlug = slugify(data.slug);
            const clash = await prisma.store.findFirst({ where: { slug: newSlug, NOT: { id: store.id } } });
            if (clash) throw apiError('That store URL is already taken.');
            data.slug = newSlug;
        }

        const updated = await prisma.store.update({ where: { id: store.id }, data });
        res.json({ data: serializeStore(updated) });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
