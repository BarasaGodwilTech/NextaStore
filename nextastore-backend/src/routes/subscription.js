const express = require('express');
const prisma = require('../prisma');
const { apiError } = require('../utils');
const { getStoreForUser, subscriptionInfo, getPlatformSettings, SUBSCRIPTION_PRICE_UGX, maybeNotifySubscriptionReminder } = require('../helpers');
const { requireAuth, requireSeller } = require('../middleware');
const { validateBody, subscriptionPaymentSchema } = require('../validation');

const router = express.Router();

function serializePayment(p) {
    return { ...p, amount: Number(p.amount) };
}

// The logged-in seller's own subscription status + their payment history.
// Trial/paid state is always recomputed live (see subscriptionInfo) so this
// is accurate even between admin approvals.
router.get('/', requireAuth, requireSeller, async (req, res, next) => {
    try {
        const store = await getStoreForUser(req.user.id);
        if (!store) throw apiError('No store found for this account.', 404);
        // Fire-and-forget, same as GET /store — see maybeNotifySubscriptionReminder
        // in helpers.js. Loading this page directly (not just the dashboard) should
        // still count as a chance to remind, and the cooldown/dedup inside it means
        // calling it from both routes never double-sends.
        maybeNotifySubscriptionReminder(store);
        const payments = await prisma.subscriptionPayment.findMany({
            where: { storeId: store.id },
            orderBy: { submittedAt: 'desc' },
            take: 20
        });
        const settings = await getPlatformSettings();
        res.json({
            data: {
                ...subscriptionInfo(store),
                payments: payments.map(serializePayment),
                paymentInfo: {
                    mtnMomoCode: settings.mtnMomoCode,
                    mtnMomoName: settings.mtnMomoName,
                    airtelMoneyCode: settings.airtelMoneyCode,
                    airtelMoneyName: settings.airtelMoneyName
                }
            }
        });
    } catch (err) { next(err); }
});

// Seller reports a mobile money payment they've already sent to NextaStore's
// number. This does not activate anything by itself — it lands as
// "pending" until an admin confirms the money actually arrived (see
// PUT /admin/subscription-payments/:id/approve). That's a deliberate,
// launch-day-simple trust boundary until a real MTN/Airtel collections API
// is wired in.
router.post('/payments', requireAuth, requireSeller, validateBody(subscriptionPaymentSchema), async (req, res, next) => {
    try {
        const store = await getStoreForUser(req.user.id);
        if (!store) throw apiError('No store found for this account.', 404);
        const { amount, method, reference, periodMonths } = req.body;
        const expectedAmount = SUBSCRIPTION_PRICE_UGX * periodMonths;
        if (amount !== expectedAmount) {
            throw apiError(`For ${periodMonths} month${periodMonths === 1 ? '' : 's'}, enter exactly ${expectedAmount.toLocaleString('en-UG')} UGX.`);
        }

        const duplicate = await prisma.subscriptionPayment.findFirst({
            where: { storeId: store.id, reference, status: { not: 'rejected' } }
        });
        if (duplicate) throw apiError('That transaction reference has already been submitted.');

        const payment = await prisma.subscriptionPayment.create({
            data: { storeId: store.id, amount, method, reference, periodMonths }
        });
        res.status(201).json({ data: serializePayment(payment) });
    } catch (err) { next(err); }
});

module.exports = router;
