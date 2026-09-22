const express = require('express');
const prisma = require('../prisma');
const { getStoreForUser } = require('../helpers');
const { requireAuth, requireSeller } = require('../middleware');

const router = express.Router();

// Distinct-customer count, computed by the database rather than by pulling
// every order's customerPhone into Node just to size the resulting array.
// `findMany({ distinct: [...] })` still has to materialize one row per
// distinct phone number and ship it over the wire — for a store with a long
// order history that's a lot of rows fetched just to read `.length`. A
// straight COUNT(DISTINCT ...) does the same dedupe work where the data
// already lives and returns exactly one row.
async function countDistinctCustomers(storeId, extraWhereSql = '', params = []) {
    const rows = await prisma.$queryRawUnsafe(
        `SELECT COUNT(DISTINCT "customerPhone")::int AS count
         FROM "Order"
         WHERE "storeId" = $1 AND "deletedAt" IS NULL ${extraWhereSql}`,
        storeId,
        ...params
    );
    return rows[0]?.count || 0;
}

router.get('/stats', requireAuth, requireSeller, async (req, res, next) => {
    try {
        const store = await getStoreForUser(req.user.id);
        if (!store) {
            return res.json({ data: { totalOrders: 0, totalRevenue: 0, totalCustomers: 0, totalProducts: 0 } });
        }

        const [totalOrders, revenueAgg, totalProducts, totalCustomers] = await Promise.all([
            prisma.order.count({ where: { storeId: store.id, deletedAt: null } }),
            prisma.order.aggregate({
                where: { storeId: store.id, deletedAt: null, status: { not: 'cancelled' } },
                _sum: { total: true }
            }),
            prisma.product.count({ where: { storeId: store.id, deletedAt: null } }),
            // Real distinct-customer count from actual order history — no
            // more seeded fake follower/customer numbers.
            countDistinctCustomers(store.id)
        ]);

        res.json({
            data: {
                totalOrders,
                totalRevenue: Number(revenueAgg._sum.total || 0),
                totalCustomers,
                totalProducts
            }
        });
    } catch (err) {
        next(err);
    }
});

// Server-side analytics for the dashboard's Analytics tab: period KPIs
// (with a same-length prior period for the "+12% vs last period" deltas),
// a revenue-by-day series for the chart, and a revenue-by-category
// breakdown — all computed as SQL aggregates instead of the frontend
// downloading every order the store has ever received and reducing it in
// the browser. That old approach re-fetched and re-summed the *entire*
// order history on every dashboard visit no matter which period was
// selected, so page-load time and payload size grew without bound as a
// store's history grew; this endpoint's cost instead scales with the
// selected window (default 30 days), which is what the user is actually
// looking at.
router.get('/analytics', requireAuth, requireSeller, async (req, res, next) => {
    try {
        const store = await getStoreForUser(req.user.id);
        const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
        if (!store) {
            return res.json({
                data: {
                    days,
                    current: { revenue: 0, orders: 0 },
                    previous: { revenue: 0, orders: 0 },
                    revenueByDay: [],
                    categoryBreakdown: []
                }
            });
        }

        const now = new Date();
        const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
        const previousCutoff = new Date(cutoff.getTime() - days * 24 * 60 * 60 * 1000);

        async function periodStats(since, until) {
            const [orders, revenueAgg] = await Promise.all([
                prisma.order.count({
                    where: { storeId: store.id, deletedAt: null, createdAt: { gte: since, lt: until } }
                }),
                prisma.order.aggregate({
                    where: { storeId: store.id, deletedAt: null, createdAt: { gte: since, lt: until }, status: { not: 'cancelled' } },
                    _sum: { total: true }
                })
            ]);
            return { orders, revenue: Number(revenueAgg._sum.total || 0) };
        }

        const [current, previous, revenueByDayRows, categoryRows] = await Promise.all([
            periodStats(cutoff, now),
            periodStats(previousCutoff, cutoff),
            // One row per calendar day with data, summed server-side —
            // never more rows than the selected window has days.
            prisma.$queryRawUnsafe(
                `SELECT to_char("createdAt", 'YYYY-MM-DD') AS day,
                        SUM(CASE WHEN status <> 'cancelled' THEN total ELSE 0 END)::float AS revenue
                 FROM "Order"
                 WHERE "storeId" = $1 AND "deletedAt" IS NULL AND "createdAt" >= $2
                 GROUP BY day
                 ORDER BY day ASC`,
                store.id,
                cutoff
            ),
            // Revenue by category from the order-line snapshot (unitPrice
            // at time of sale), not today's live product price — a price
            // change or a since-deleted product must not silently distort
            // history the way reading Product.price live would.
            prisma.$queryRawUnsafe(
                `SELECT COALESCE(p.category, 'other') AS category,
                        SUM(oi."unitPrice" * oi.quantity)::float AS revenue
                 FROM "OrderItem" oi
                 JOIN "Order" o ON o.id = oi."orderId"
                 LEFT JOIN "Product" p ON p.id = oi."productId"
                 WHERE o."storeId" = $1 AND o."deletedAt" IS NULL AND o."createdAt" >= $2 AND o.status <> 'cancelled'
                 GROUP BY category
                 ORDER BY revenue DESC`,
                store.id,
                cutoff
            )
        ]);

        res.json({
            data: {
                days,
                current,
                previous,
                revenueByDay: revenueByDayRows.map(r => ({ date: r.day, revenue: Number(r.revenue) })),
                categoryBreakdown: categoryRows.map(r => ({ category: r.category, revenue: Number(r.revenue) }))
            }
        });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
