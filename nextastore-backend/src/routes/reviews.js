const express = require('express');
const prisma = require('../prisma');
const { apiError } = require('../utils');
const { requireAuth } = require('../middleware');
const { validateBody, reviewSchema } = require('../validation');

const router = express.Router();

// A buyer can review a product once. There's deliberately no requirement
// that they've actually bought it — Order.items only stores a snapshot
// (productName) rather than a durable link a review could check against,
// and requiring proof-of-purchase is a real feature but a bigger one than
// this pass has room for. Noted as a gap, not silently assumed away.
router.post('/', requireAuth, validateBody(reviewSchema), async (req, res, next) => {
    try {
        const { productId, rating, body } = req.body;
        const product = await prisma.product.findFirst({ where: { id: productId, deletedAt: null } });
        if (!product) throw apiError('Product not found.', 404);

        const existing = await prisma.review.findUnique({
            where: { productId_buyerId: { productId, buyerId: req.user.id } }
        });
        if (existing) throw apiError('You already reviewed this product.');

        await prisma.review.create({ data: { productId, buyerId: req.user.id, rating, body } });

        // Product.rating/reviews are plain columns, recomputed here rather
        // than derived on every product read — see the schema comment on
        // Review for why.
        const agg = await prisma.review.aggregate({ where: { productId }, _avg: { rating: true }, _count: true });
        const updated = await prisma.product.update({
            where: { id: productId },
            data: { rating: agg._avg.rating || 0, reviews: agg._count }
        });

        res.status(201).json({ data: { rating: updated.rating, reviews: updated.reviews } });
    } catch (err) {
        next(err);
    }
});

router.get('/', async (req, res, next) => {
    try {
        const { productId } = req.query;
        if (!productId) throw apiError('productId is required.');

        const page = Math.max(1, Number(req.query.page) || 1);
        const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 10));

        const [reviews, total] = await Promise.all([
            prisma.review.findMany({
                where: { productId },
                include: { buyer: { select: { id: true, name: true } } },
                orderBy: { createdAt: 'desc' },
                skip: (page - 1) * limit,
                take: limit
            }),
            prisma.review.count({ where: { productId } })
        ]);

        res.json({
            data: reviews.map(r => ({ id: r.id, rating: r.rating, body: r.body, createdAt: r.createdAt, buyerName: r.buyer.name })),
            pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 }
        });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
