const express = require('express');
const prisma = require('../prisma');
const { apiError, saveImageIfDataUrl, slugify, isReservedSlug, deleteImageIfReplaced } = require('../utils');
const { getStoreForUser, resolveContextStore, serializeStore, serializePublicStore, serializeProduct, assertStoreVisible, storefrontVisibleWhere, maybeNotifySubscriptionReminder, createNotification, ownerLifecycle } = require('../helpers');
const { requireAuth, requireSeller, optionalAuth } = require('../middleware');
const { validateBody, updateStoreSchema } = require('../validation');
const { cacheResponse } = require('../cacheMiddleware');

const router = express.Router();

// Real store follow state/actions. A unique (user, store) row makes repeated
// follow clicks idempotent; the public counter is updated in the same transaction.
router.get('/follow/:storeId', optionalAuth, async (req, res, next) => {
    try {
        // Same rule as the storefront itself: a draft or lapsed store answers
        // like a store that does not exist (its owner excepted), so this can
        // not be used to probe ids or read a hidden store's follower count.
        const store = await prisma.store.findFirst({
            where: { id: req.params.storeId, deletedAt: null, OR: [{ AND: [storefrontVisibleWhere()] }, ...(req.user ? [{ ownerId: req.user.id }] : [])] },
            select: { id: true, followers: true }
        });
        if (!store) throw apiError('Store not found.', 404);
        const following = req.user
            ? !!(await prisma.storeFollow.findUnique({ where: { userId_storeId: { userId: req.user.id, storeId: store.id } }, select: { id: true } }))
            : false;
        res.json({ data: { following, followers: store.followers } });
    } catch (err) { next(err); }
});

router.post('/follow/:storeId', requireAuth, async (req, res, next) => {
    try {
        // Same visibility rule as everywhere else a buyer can reach a store:
        // no new engagement with one that's still in draft or has let its
        // trial lapse without paying. An existing follow from before a store
        // went inactive is left alone (see GET /follows above) — this only
        // stops *new* follows.
        const store = await prisma.store.findFirst({ where: { id: req.params.storeId, ...storefrontVisibleWhere() }, select: { id: true } });
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

        // Only stores that are open right now: a followed store that lapsed
        // drops off the list (the follow itself is kept, so it returns with
        // the store) instead of linking to a page that says "closed".
        const where = { userId: req.user.id, store: storefrontVisibleWhere() };

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
//
// Built for a directory that keeps growing: always paginated (limit capped at 50),
// the order is deterministic (a unique `id` tie-breaker, so no store is skipped or
// repeated between pages when many share a createdAt), and a page far past the end
// is clamped to a harmless value instead of a deep OFFSET scan. Optional query
// params: q, category, sort (featured | newest | name), badged=1 (badge holders only).
const DIRECTORY_SORTS = {
    featured: [{ verified: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }],
    newest: [{ createdAt: 'desc' }, { id: 'asc' }],
    name: [{ name: 'asc' }, { id: 'asc' }]
};
const DIRECTORY_MAX_PAGE = 5000;
router.get('/public/all', cacheResponse(30), async (req, res, next) => {
    try {
        const page = Math.min(DIRECTORY_MAX_PAGE, Math.max(1, Math.floor(Number(req.query.page)) || 1));
        const limit = Math.min(50, Math.max(1, Math.floor(Number(req.query.limit)) || 12));
        const q = String(req.query.q || '').trim().slice(0, 100);
        const category = String(req.query.category || '').trim().slice(0, 60);
        const sortKey = Object.prototype.hasOwnProperty.call(DIRECTORY_SORTS, req.query.sort) ? req.query.sort : 'featured';
        const badgedOnly = req.query.badged === '1' || req.query.badged === 'true';
        const where = {
            // Draft stores (setup not yet launched), and stores whose trial
            // has lapsed with no confirmed payment, never appear on the
            // public marketplace.
            ...storefrontVisibleWhere(),
            // AND (not a second top-level OR) so this doesn't clobber the
            // OR that storefrontVisibleWhere() already carries — two OR
            // keys on the same object would silently overwrite one.
            ...(q ? {
                AND: [{
                    OR: [
                        { name: { contains: q, mode: 'insensitive' } },
                        { description: { contains: q, mode: 'insensitive' } },
                        { district: { contains: q, mode: 'insensitive' } },
                        { address: { contains: q, mode: 'insensitive' } }
                    ]
                }]
            } : {}),
            ...(category && category !== 'all' ? { products: { some: { category, deletedAt: null } } } : {}),
            // Same rule the badge itself uses (see subscriptionInfo): a confirmed, still-running paid commitment of 6+ months.
            ...(badgedOnly ? { verified: true, badgeCommitmentMonths: { gte: 6 }, subscriptionPaidUntil: { gt: new Date() } } : {}),
        };
        const [stores, total] = await Promise.all([
            prisma.store.findMany({
                where,
                // A badge gives a store a small edge: badged stores are listed
                // ahead of unbadged ones, newest first within each group.
                // `verified` is only true for a store that qualified for a badge
                // (6+ month paid commitment). Deliberately NO ordering between
                // Verified / Gold / Platinum - the tier is shown, not ranked -
                // and real placement is reserved for paid promotion.
                orderBy: DIRECTORY_SORTS[sortKey],
                skip: (page - 1) * limit,
                take: limit
            }),
            prisma.store.count({ where })
        ]);

        if (!stores.length) {
            return res.json({ data: [], pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 } });
        }

        const ids = stores.map(s => s.id);
        const [counts, categoryRows] = await Promise.all([
            prisma.product.groupBy({
                by: ['storeId'],
                where: { storeId: { in: ids }, deletedAt: null },
                _count: { _all: true }
            }),
            prisma.product.groupBy({
                by: ['storeId', 'category'],
                where: { storeId: { in: ids }, deletedAt: null },
                _count: { _all: true }
            })
        ]);

        const countByStore = new Map(counts.map(c => [c.storeId, c._count._all]));
        const categoriesByStore = new Map();
        categoryRows.forEach(row => {
            if (!categoriesByStore.has(row.storeId)) categoriesByStore.set(row.storeId, []);
            categoriesByStore.get(row.storeId).push(row.category);
        });

        res.json({
            data: stores.map(store => ({
                ...serializePublicStore(store, { productCount: countByStore.get(store.id) || 0 }),
                productCount: countByStore.get(store.id) || 0,
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
                // Draft stores, and stores whose trial has lapsed with no
                // confirmed payment, never surface in search either.
                where: { ...storefrontVisibleWhere(), name: contains },
                select: { id: true, slug: true, name: true, logo: true, bannerColor: true, badgeCommitmentMonths: true, verified: true, subscriptionPaidUntil: true, trialEndsAt: true, description: true, district: true, address: true },
                // Same small edge as the marketplace list: badged first, then newest.
                orderBy: [{ verified: 'desc' }, { createdAt: 'desc' }],
                take: Math.min(4, limit)
            }),
            prisma.product.findMany({
                where: { deletedAt: null, name: contains, store: storefrontVisibleWhere() },
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

/** Only the store's own owner ever gets a `preview` block: what state their
 *  storefront is in (draft / lapsed / ending soon), so the page can show them
 *  a banner about it. Everyone else gets nothing extra - a shopper is never
 *  told whether, or why, a store is closed. */
function ownerPreviewFor(store, req) {
    if (!req.user || req.user.id !== store.ownerId) return {};
    return { preview: ownerLifecycle(store) };
}

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
        assertStoreVisible(store, req);
        const [productCount, categoryRows, priceAgg] = await Promise.all([
            prisma.product.count({ where: { storeId: store.id, deletedAt: null } }),
            prisma.product.groupBy({ by: ['category'], where: { storeId: store.id, deletedAt: null }, _count: { _all: true } }),
            // Lowest / highest live price — drives the storefront's price
            // slider so its ends match what this store actually sells.
            prisma.product.aggregate({ where: { storeId: store.id, deletedAt: null }, _min: { price: true }, _max: { price: true } })
        ]);
        const minPrice = priceAgg?._min?.price;
        const maxPrice = priceAgg?._max?.price;
        const priceRange = (minPrice === null || minPrice === undefined || maxPrice === null || maxPrice === undefined)
            ? null
            : { min: Number(minPrice), max: Number(maxPrice) };
        res.json({ data: { ...serializePublicStore(store, { productCount }), productCount, priceRange, categories: categoryRows.map(row => row.category), ...ownerPreviewFor(store, req) } });
    } catch (err) {
        next(err);
    }
});

router.get('/public', optionalAuth, async (req, res, next) => {
    try {
        const store = await resolveContextStore(req);
        if (!store) throw apiError('Store not found.', 404);
        assertStoreVisible(store, req);
        const [productCount, categoryRows, priceAgg] = await Promise.all([
            prisma.product.count({ where: { storeId: store.id, deletedAt: null } }),
            prisma.product.groupBy({ by: ['category'], where: { storeId: store.id, deletedAt: null }, _count: { _all: true } }),
            // Lowest / highest live price — drives the storefront's price
            // slider so its ends match what this store actually sells.
            prisma.product.aggregate({ where: { storeId: store.id, deletedAt: null }, _min: { price: true }, _max: { price: true } })
        ]);
        const minPrice = priceAgg?._min?.price;
        const maxPrice = priceAgg?._max?.price;
        const priceRange = (minPrice === null || minPrice === undefined || maxPrice === null || maxPrice === undefined)
            ? null
            : { min: Number(minPrice), max: Number(maxPrice) };
        res.json({ data: { ...serializePublicStore(store, { productCount }), productCount, priceRange, categories: categoryRows.map(row => row.category), ...ownerPreviewFor(store, req) } });
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
            // The link is a bare top-level path (nextastores.com/<slug>), so a
            // few words are taken by the site itself: login, cart, admin, ...
            if (newSlug !== store.slug && isReservedSlug(newSlug)) throw apiError('That store link is reserved. Please choose another one.');
            const clash = await prisma.store.findFirst({ where: { slug: newSlug, NOT: { id: store.id } } });
            if (clash) throw apiError('That store URL is already taken.');
            data.slug = newSlug;
        }

        // Onboarding's UI already blocks Launch with zero products, but
        // that's just a disabled button — an old tab left open on step 4,
        // or a direct API call, could still send isPublished:true straight
        // through. Re-check server-side so a store can never actually go
        // live with an empty shelf, no matter how the request got here.
        if (data.isPublished === true && !store.isPublished) {
            const productCount = await prisma.product.count({ where: { storeId: store.id, deletedAt: null } });
            if (productCount === 0) {
                throw apiError('Add at least one product before you launch your store.', 400);
            }
        }

        const updated = await prisma.store.update({ where: { id: store.id }, data });

        // Draft -> live. Onboarding's Launch button is the only caller that
        // sends isPublished, so this fires once, at the moment the seller
        // goes public. It lands in the bell and (if they've allowed push) on
        // their phone, so the confirmation survives closing the tab right
        // after launching. createNotification never throws, and is not
        // awaited: launching must not wait on or fail because of it.
        if (data.isPublished === true && !store.isPublished) {
            createNotification({
                userId: store.ownerId,
                type: 'store_live',
                title: 'Your store is live',
                body: `${updated.name} is now open to shoppers. Share your store link to get your first visitors.`,
                link: '/dashboard'
            });
        }
        res.json({ data: serializeStore(updated) });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
