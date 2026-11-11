'use strict';
/* Seller Pass payments, platform settings and the payment-method catalogue. */
const express = require('express');
const prisma = require('../../prisma');
const { apiError } = require('../../utils');
const growth = require('../../growthInstance');
const { createNotification, getPlatformSettings } = require('../../helpers');
const { validateBody, platformSettingsSchema, paymentMethodCreateSchema, paymentMethodUpdateSchema } = require('../../validation');
const A = require('../auth');
const { PERMISSIONS: PM } = require('../permissions');

const router = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const money = (d) => (d == null ? 0 : Number(d));
const serializePayment = (p) => ({ ...p, amount: money(p.amount) });

router.get('/subscription-payments', A.requireAnyPermission(PM.SUBSCRIPTIONS_REVIEW, PM.FINANCE_VIEW), wrap(async (req, res) => {
    const status = ['pending', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : undefined;
    const payments = await prisma.subscriptionPayment.findMany({
        where: status ? { status } : {},
        include: { store: { select: { id: true, name: true, slug: true, ownerId: true, badgeCommitmentMonths: true, subscriptionPaidUntil: true, verified: true, owner: { select: { name: true, email: true } } } } },
        orderBy: [{ status: 'asc' }, { submittedAt: 'desc' }], take: 200
    });
    res.json({ data: payments.map(serializePayment) });
}));

router.put('/subscription-payments/:id/approve', A.requirePermission(PM.SUBSCRIPTIONS_REVIEW), wrap(async (req, res) => {
    const payment = await prisma.subscriptionPayment.findUnique({ where: { id: req.params.id }, include: { store: true } });
    if (!payment) throw apiError('Payment not found.', 404, 'NOT_FOUND');
    if (payment.status !== 'pending') throw apiError('This payment was already reviewed.', 409);

    const months = Number(payment.periodMonths || 1);
    const now = new Date();
    const existingPaidUntil = payment.store.subscriptionPaidUntil ? new Date(payment.store.subscriptionPaidUntil) : null;
    const wasAlreadyPaid = !!existingPaidUntil && existingPaidUntil.getTime() > now.getTime();
    const base = new Date(wasAlreadyPaid ? existingPaidUntil : now);   // copy: setMonth mutates
    base.setMonth(base.getMonth() + months);
    // The commitment counter follows continuous paid coverage: 6 months unlocks Verified Seller, a lapse starts a new cycle.
    const commitmentMonths = (wasAlreadyPaid ? Number(payment.store.badgeCommitmentMonths || 0) : 0) + months;
    const badgeEligible = commitmentMonths >= 6;

    // Claim the review atomically: two staff clicking Approve at once can only ever extend the subscription once.
    const claimed = await prisma.subscriptionPayment.updateMany({ where: { id: payment.id, status: 'pending' }, data: { status: 'approved', reviewedAt: now, reviewedBy: req.staff.id } });
    if (claimed.count === 0) throw apiError('This payment was already reviewed.', 409);
    const updatedStore = await prisma.store.update({ where: { id: payment.storeId }, data: { subscriptionStatus: 'active', subscriptionPaidUntil: base, badgeCommitmentMonths: commitmentMonths, verified: badgeEligible } });

    await A.audit(req, 'subscription_payment.approved', 'subscription_payment', payment.id, { targetUserId: payment.store.ownerId, metadata: { months, amount: money(payment.amount), commitmentMonths, badgeEligible, reference: payment.reference } });
    if (payment.store.ownerId) {
        await createNotification({
            userId: payment.store.ownerId, type: 'subscription', title: 'Seller Pass confirmed',
            body: badgeEligible
                ? `Your payment is confirmed. You now have ${commitmentMonths} months of active paid coverage and your ${commitmentMonths >= 24 ? 'Platinum Partner' : commitmentMonths >= 12 ? 'Gold Partner' : 'Verified Seller'} badge is live.`
                : `Your ${months}-month payment is confirmed. You now have ${commitmentMonths} months covered. Add ${6 - commitmentMonths} more month${6 - commitmentMonths === 1 ? '' : 's'} while your pass is active to unlock Verified Seller.`,
            link: '/subscription'
        });
    }
    // Circle / Crew: the money moment (recruiter earning + fraud checks). Never throws, never delays the approval.
    growth.hooks.safe.onPaymentApproved({ payment, store: { ...payment.store, name: payment.store.name }, adminId: req.staff.id, previousPaidUntil: existingPaidUntil });
    res.json({ data: { success: true, subscriptionPaidUntil: updatedStore.subscriptionPaidUntil, commitmentMonths, badgeEligible } });
}));

router.put('/subscription-payments/:id/reject', A.requirePermission(PM.SUBSCRIPTIONS_REVIEW), wrap(async (req, res) => {
    const note = String((req.body && req.body.note) || '').trim().slice(0, 500);
    const existing = await prisma.subscriptionPayment.findUnique({ where: { id: req.params.id }, include: { store: true } });
    if (!existing) throw apiError('Payment not found.', 404, 'NOT_FOUND');
    if (existing.status !== 'pending') throw apiError('This payment was already reviewed.', 409);
    const claimed = await prisma.subscriptionPayment.updateMany({ where: { id: existing.id, status: 'pending' }, data: { status: 'rejected', reviewedAt: new Date(), reviewedBy: req.staff.id, note } });
    if (claimed.count === 0) throw apiError('This payment was already reviewed.', 409);
    await A.audit(req, 'subscription_payment.rejected', 'subscription_payment', existing.id, { targetUserId: existing.store.ownerId, metadata: { note: note || null } });
    if (existing.store.ownerId) await createNotification({ userId: existing.store.ownerId, type: 'subscription', title: 'Payment needs attention', body: note || 'We could not confirm that transaction reference. Please check the mobile-money receipt and submit it again.', link: '/subscription' });
    growth.hooks.safe.onPaymentRejected({ payment: { ...existing, status: 'rejected' }, store: existing.store });
    res.json({ data: serializePayment({ ...existing, status: 'rejected', note }) });
}));

// ---- Platform settings (step-up required: these change what every shopper and seller sees) ---------------------------------------
router.get('/settings', A.requirePermission(PM.SETTINGS_MANAGE), wrap(async (req, res) => res.json({ data: await getPlatformSettings() })));

router.put('/settings', A.requirePermission(PM.SETTINGS_MANAGE), A.requireRecentAuth, validateBody(platformSettingsSchema), wrap(async (req, res) => {
    const settings = await prisma.platformSettings.upsert({ where: { id: 'singleton' }, update: req.body, create: { id: 'singleton', ...req.body } });
    await A.audit(req, 'platform_settings.updated', 'platform_settings', 'singleton', { metadata: { fields: Object.keys(req.body) } });
    res.json({ data: settings });
}));

router.get('/payment-methods', A.requirePermission(PM.SETTINGS_MANAGE), wrap(async (req, res) => res.json({ data: await prisma.paymentMethod.findMany({ orderBy: { sortOrder: 'asc' } }) })));

router.post('/payment-methods', A.requirePermission(PM.SETTINGS_MANAGE), A.requireRecentAuth, validateBody(paymentMethodCreateSchema), wrap(async (req, res) => {
    if (await prisma.paymentMethod.findUnique({ where: { code: req.body.code } })) throw apiError('A payment method with that code already exists.', 409);
    const method = await prisma.paymentMethod.create({ data: req.body });
    await A.audit(req, 'payment_method.created', 'payment_method', method.id, { metadata: { code: method.code } });
    res.status(201).json({ data: method });
}));

router.put('/payment-methods/:id', A.requirePermission(PM.SETTINGS_MANAGE), A.requireRecentAuth, validateBody(paymentMethodUpdateSchema), wrap(async (req, res) => {
    const existing = await prisma.paymentMethod.findUnique({ where: { id: req.params.id } });
    if (!existing) throw apiError('Payment method not found.', 404, 'NOT_FOUND');
    const method = await prisma.paymentMethod.update({ where: { id: existing.id }, data: req.body });
    await A.audit(req, 'payment_method.updated', 'payment_method', method.id, { metadata: { fields: Object.keys(req.body) } });
    res.json({ data: method });
}));

router.delete('/payment-methods/:id', A.requirePermission(PM.SETTINGS_MANAGE), A.requireRecentAuth, wrap(async (req, res) => {
    const existing = await prisma.paymentMethod.findUnique({ where: { id: req.params.id } });
    if (!existing) throw apiError('Payment method not found.', 404, 'NOT_FOUND');
    await prisma.paymentMethod.delete({ where: { id: existing.id } });
    await A.audit(req, 'payment_method.deleted', 'payment_method', existing.id, { metadata: { code: existing.code } });
    res.json({ data: { ok: true } });
}));

module.exports = router;
