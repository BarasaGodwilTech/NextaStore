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
                // So the page header's "My store" link can point at the store's real
                // address (/<slug>) instead of a generic page.
                storeSlug: store.slug || null,
                payments: payments.map(serializePayment),
                paymentInfo: {
                    mtnMomoCode: settings.mtnMomoCode,
                    mtnMomoName: settings.mtnMomoName,
                    airtelMoneyCode: settings.airtelMoneyCode,
                    airtelMoneyName: settings.airtelMoneyName,
                    mtnMomoInstructions: settings.mtnMomoInstructions,
                    airtelMoneyInstructions: settings.airtelMoneyInstructions
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

        // One mobile-money transaction can only pay for one thing. The check is
        // across ALL stores (it used to be per store, so the same receipt could
        // be submitted by several stores and an admin approving each in turn
        // would grant several passes for one payment). Case-insensitive, and
        // only rejected submissions free a reference up again.
        const duplicate = await prisma.subscriptionPayment.findFirst({
            where: { reference: { equals: reference, mode: 'insensitive' }, status: { not: 'rejected' } }
        });
        if (duplicate) throw apiError('That transaction reference has already been submitted.');

        // A queue of unreviewed claims is the only thing an admin has to wade
        // through, so it is capped per store.
        const pending = await prisma.subscriptionPayment.count({ where: { storeId: store.id, status: 'pending' } });
        if (pending >= 3) throw apiError('You already have payments waiting for review. Please wait for them to be confirmed before submitting another.', 429);

        const payment = await prisma.subscriptionPayment.create({
            data: { storeId: store.id, amount, method, reference, periodMonths }
        });
        res.status(201).json({ data: serializePayment(payment) });
    } catch (err) { next(err); }
});

module.exports = router;
