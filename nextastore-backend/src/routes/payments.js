const express = require('express');
const prisma = require('../prisma');
const { getActivePaymentMethods } = require('../helpers');

const router = express.Router();

// Dynamic replacement for the payment options that used to be hardcoded
// into cart-page.js, dashboard.js, and orders.js. Public and unauthenticated
// — the checkout screen needs this before a buyer is necessarily logged in.
// Optional ?storeId= pre-filters to methods that store has actually opted
// into (Store.payments), so the frontend doesn't need its own copy of that
// intersection logic; without it, every platform-active method is returned.
router.get('/methods', async (req, res, next) => {
    try {
        const methods = await getActivePaymentMethods();
        const storeId = typeof req.query.storeId === 'string' ? req.query.storeId.trim() : '';
        if (!storeId) {
            res.json({ data: methods });
            return;
        }
        const store = await prisma.store.findUnique({ where: { id: storeId }, select: { payments: true } });
        const accepted = (store && store.payments) || {};
        res.json({ data: store ? methods.filter(m => !!accepted[m.code]) : methods });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
