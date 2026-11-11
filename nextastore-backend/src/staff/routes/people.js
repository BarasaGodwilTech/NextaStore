'use strict';
/* Accounts (shoppers and sellers), stores, products, orders and buyer reports: the marketplace side of the console. */
const express = require('express');
const prisma = require('../../prisma');
const config = require('../../config');
const { apiError } = require('../../utils');
const { issueToken } = require('../../verification');
const { sendMail } = require('../../mailer');
const emails = require('../../emailTemplates');
const { createNotification, subscriptionInfo } = require('../../helpers');
const { removeAllSubscriptionsForUser } = require('../../push');
const presence = require('../../presence');
const cache = require('../../cache');
const A = require('../auth');
const { hasPermission, PERMISSIONS: PM } = require('../permissions');

const router = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const can = (req, p) => hasPermission(req.staff, p);
const pageOf = (req, def = 25) => ({ page: Math.max(1, Number(req.query.page) || 1), pageSize: Math.min(100, Math.max(10, Number(req.query.pageSize) || def)) });
const money = (d) => (d == null ? 0 : Number(d));
const emailRe = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// ---- shapes: staff never receive password hashes, Google ids or token versions ------------------------------------------------------------
const storeBrief = (s) => s && ({ id: s.id, name: s.name, slug: s.slug, isPublished: !!s.isPublished, verified: !!s.verified, moderationStatus: s.moderationStatus || 'ok', subscription: subscriptionInfo(s) });
const userOut = (u) => ({
    id: u.id, name: u.name, email: u.email, role: u.role, accountStatus: u.accountStatus || 'active',
    emailVerified: !!u.emailVerifiedAt, googleLinked: !!u.googleId, lastActiveAt: u.lastActiveAt || null, createdAt: u.createdAt,
    store: storeBrief(u.store)
});

// ---- Users ------------------------------------------------------------------------------------------------------------------------------
router.get('/users', A.requirePermission(PM.USERS_VIEW), wrap(async (req, res) => {
    const { page, pageSize } = pageOf(req);
    const search = String(req.query.q || req.query.search || '').trim().slice(0, 100);
    const role = ['buyer', 'seller'].includes(req.query.role) ? req.query.role : undefined;
    const accountStatus = ['active', 'suspended'].includes(req.query.accountStatus) ? req.query.accountStatus : undefined;
    const where = { ...(role ? { role } : {}), ...(accountStatus ? { accountStatus } : {}),
        ...(search ? { OR: [{ name: { contains: search, mode: 'insensitive' } }, { email: { contains: search, mode: 'insensitive' } }, { id: { equals: search } }] } : {}) };
    const [rows, total] = await Promise.all([
        prisma.user.findMany({ where, include: { store: true }, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
        prisma.user.count({ where })
    ]);
    res.json({ data: { users: rows.map(userOut), page, pageSize, total, pages: Math.max(1, Math.ceil(total / pageSize)) } });
}));

/** Customer 360: everything about one account, with each block gated by the permission that owns it. */
router.get('/users/:id', A.requirePermission(PM.USERS_VIEW), wrap(async (req, res) => {
    const user = await prisma.user.findUnique({ where: { id: req.params.id }, include: { store: true } });
    if (!user) throw apiError('Account not found.', 404, 'NOT_FOUND');
    const staffBrief = { select: { id: true, name: true } };
    const [orders, payments, reports, notes, followUps, tickets, auditRows] = await Promise.all([
        can(req, PM.ORDERS_VIEW) ? prisma.order.findMany({ where: { OR: [{ buyerId: user.id }, ...(user.store ? [{ storeId: user.store.id }] : [])], deletedAt: null }, orderBy: { createdAt: 'desc' }, take: 15, include: { store: { select: { id: true, name: true } } } }) : null,
        user.store && (can(req, PM.FINANCE_VIEW) || can(req, PM.SUBSCRIPTIONS_REVIEW)) ? prisma.subscriptionPayment.findMany({ where: { storeId: user.store.id }, orderBy: { submittedAt: 'desc' }, take: 10 }) : null,
        can(req, PM.REPORTS_REVIEW) ? prisma.orderReport.findMany({ where: { reporterId: user.id }, orderBy: { createdAt: 'desc' }, take: 10 }) : null,
        can(req, PM.USERS_NOTES) ? prisma.userNote.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'desc' }, take: 50 }) : null,
        can(req, PM.FOLLOWUPS_MANAGE) ? prisma.adminFollowUp.findMany({ where: { relatedUserId: user.id }, orderBy: { createdAt: 'desc' }, take: 20, include: { assignedTo: staffBrief } }) : null,
        can(req, PM.TICKETS_VIEW) ? prisma.supportTicket.findMany({ where: { requesterId: user.id }, orderBy: { createdAt: 'desc' }, take: 15 }) : null,
        can(req, PM.AUDIT_VIEW) ? prisma.adminAuditLog.findMany({ where: { targetUserId: user.id }, orderBy: { createdAt: 'desc' }, take: 30, include: { actor: { select: { id: true, name: true, email: true } } } }) : null
    ]);
    res.json({ data: {
        user: userOut(user),
        orders: orders && orders.map((o) => ({ id: o.id, status: o.status, total: money(o.total), paymentStatus: o.paymentStatus, flaggedAt: o.flaggedAt, createdAt: o.createdAt, store: o.store, asBuyer: o.buyerId === user.id })),
        payments: payments && payments.map((p) => ({ id: p.id, status: p.status, amount: money(p.amount), periodMonths: p.periodMonths, submittedAt: p.submittedAt })),
        reports: reports && reports.map((r) => ({ id: r.id, orderId: r.orderId, reason: r.reason, reviewedAt: r.reviewedAt, createdAt: r.createdAt })),
        notes, followUps, tickets: tickets && tickets.map((t) => ({ id: t.id, number: t.number, subject: t.subject, status: t.status, priority: t.priority, createdAt: t.createdAt })),
        audit: auditRows && auditRows.map((r) => ({ id: r.id, at: r.createdAt, action: r.action, actor: r.actor, metadata: r.metadata }))
    } });
}));

router.put('/users/:id', A.requireAnyPermission(PM.USERS_EDIT, PM.USERS_SUSPEND), wrap(async (req, res) => {
    const target = await prisma.user.findUnique({ where: { id: req.params.id }, include: { store: true } });
    if (!target) throw apiError('Account not found.', 404, 'NOT_FOUND');
    const b = req.body || {};
    const nameChanged = typeof b.name === 'string' && b.name.trim() !== target.name;
    const emailChanged = typeof b.email === 'string' && b.email.trim().toLowerCase() !== target.email.toLowerCase();
    const roleChanged = b.role !== undefined && b.role !== target.role;
    const statusChanged = b.accountStatus !== undefined && b.accountStatus !== (target.accountStatus || 'active');
    // Each kind of change needs its own permission.
    if ((nameChanged || emailChanged || roleChanged) && !can(req, PM.USERS_EDIT)) throw apiError('You do not have permission to edit account details.', 403, 'STAFF_FORBIDDEN');
    if (statusChanged && !can(req, PM.USERS_SUSPEND)) throw apiError('You do not have permission to suspend or reactivate accounts.', 403, 'STAFF_FORBIDDEN');
    if (!nameChanged && !emailChanged && !roleChanged && !statusChanged) throw apiError('Nothing to change.', 400);
    if (roleChanged && !['buyer', 'seller'].includes(b.role)) throw apiError('Account type must be buyer or seller.', 400);
    if (roleChanged && b.role === 'buyer' && target.store) throw apiError('This seller already has a store. Keep the account as a seller or restrict its store instead.', 409);
    if (statusChanged && !['active', 'suspended'].includes(b.accountStatus)) throw apiError('Status must be active or suspended.', 400);
    const reason = String(b.reason || '').trim().slice(0, 300);
    if (statusChanged && b.accountStatus === 'suspended' && reason.length < 3) throw apiError('Give a short reason for the suspension.', 400, 'REASON_REQUIRED');
    const data = {};
    if (nameChanged) { const n = b.name.trim(); if (n.length < 2 || n.length > 80) throw apiError('Enter a name of 2 to 80 characters.', 400); data.name = n; }
    if (emailChanged) {
        const e = b.email.trim().toLowerCase();
        if (!emailRe.test(e) || e.length > 254) throw apiError('Enter a valid email address.', 400);
        if (await prisma.user.findUnique({ where: { email: e } })) throw apiError('That email is already used by another account.', 409);
        data.email = e; data.emailVerifiedAt = null;
        data.tokenVersion = { increment: 1 };   // the address changed: sign the old holder out
    }
    if (roleChanged) data.role = b.role;
    if (statusChanged) data.accountStatus = b.accountStatus;
    const updated = await prisma.user.update({ where: { id: target.id }, data, include: { store: true } });
    if (statusChanged && b.accountStatus === 'suspended') {
        await removeAllSubscriptionsForUser(target.id);
        presence.disconnectUser(target.id, 'session-ended');
    }
    if (statusChanged) {
        await prisma.userNote.create({ data: { userId: target.id, authorId: req.staff.id, authorName: req.staff.name, body: `${b.accountStatus === 'suspended' ? 'Suspended' : 'Reactivated'}${reason ? `: ${reason}` : ''}` } });
    }
    await A.audit(req, statusChanged ? (b.accountStatus === 'suspended' ? 'user.suspended' : 'user.reactivated') : 'user.updated', 'user', target.id, { targetUserId: target.id, metadata: { fields: Object.keys(data).filter((k) => k !== 'tokenVersion' && k !== 'emailVerifiedAt'), reason: reason || undefined } });
    res.json({ data: userOut(updated) });
}));

/** The link goes ONLY to the account's own inbox. Staff never see it: a reset link in a support agent's hands is an account takeover. */
router.post('/users/:id/password-reset', A.requirePermission(PM.USERS_PASSWORD_RESET), wrap(async (req, res) => {
    const target = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!target) throw apiError('Account not found.', 404, 'NOT_FOUND');
    const token = await issueToken(target.id, 'password_reset');
    let emailed = true;
    try { await sendMail({ to: target.email, ...emails.resetPassword({ name: target.name, link: `${config.frontendUrl}/forgot-password?token=${encodeURIComponent(token)}` }) }); }
    catch (err) { emailed = false; console.error('Staff-requested password reset email failed:', err.message); }
    await A.audit(req, 'user.password_reset_requested', 'user', target.id, { targetUserId: target.id, metadata: { emailed } });
    res.json({ data: { emailed, message: emailed ? 'A reset link was emailed to the account holder.' : 'The email could not be sent. Try again shortly.' } });
}));

router.post('/users/:id/sign-out', A.requirePermission(PM.USERS_SESSIONS), wrap(async (req, res) => {
    const target = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!target) throw apiError('Account not found.', 404, 'NOT_FOUND');
    await prisma.user.update({ where: { id: target.id }, data: { tokenVersion: { increment: 1 } } });
    await removeAllSubscriptionsForUser(target.id);
    presence.disconnectUser(target.id, 'session-ended');
    await A.audit(req, 'user.signed_out_everywhere', 'user', target.id, { targetUserId: target.id });
    res.json({ data: { ok: true } });
}));

router.post('/users/:id/notes', A.requirePermission(PM.USERS_NOTES), wrap(async (req, res) => {
    const body = String((req.body && req.body.body) || '').trim();
    if (body.length < 2 || body.length > 2000) throw apiError('Write a note of 2 to 2000 characters.', 400);
    const target = await prisma.user.findUnique({ where: { id: req.params.id }, select: { id: true } });
    if (!target) throw apiError('Account not found.', 404, 'NOT_FOUND');
    const note = await prisma.userNote.create({ data: { userId: target.id, authorId: req.staff.id, authorName: req.staff.name, body } });
    await A.audit(req, 'user.note_added', 'user', target.id, { targetUserId: target.id });
    res.status(201).json({ data: note });
}));

// ---- Stores ----------------------------------------------------------------------------------------------------------------------------
const clearPublicCaches = () => Promise.all(['stores:public:all', 'products:deals'].map((k) => cache.del(k).catch(() => {}))).catch(() => {});

const storeRow = (s) => ({ id: s.id, name: s.name, slug: s.slug, district: s.district, isPublished: !!s.isPublished, verified: !!s.verified, moderationStatus: s.moderationStatus || 'ok', moderationNote: s.moderationNote || '', subscription: subscriptionInfo(s), createdAt: s.createdAt, owner: s.owner ? { id: s.owner.id, name: s.owner.name, email: s.owner.email, accountStatus: s.owner.accountStatus } : null, products: s._count ? s._count.products : undefined });

router.get('/stores', A.requirePermission(PM.STORES_VIEW), wrap(async (req, res) => {
    const { page, pageSize } = pageOf(req);
    const q = String(req.query.q || '').trim().slice(0, 100);
    const f = String(req.query.filter || '');
    const now = new Date();
    const where = { deletedAt: null,
        ...(q ? { OR: [{ name: { contains: q, mode: 'insensitive' } }, { slug: { contains: q, mode: 'insensitive' } }, { id: { equals: q } }, { owner: { email: { contains: q, mode: 'insensitive' } } }] } : {}),
        ...(f === 'restricted' ? { moderationStatus: 'restricted' } : f === 'draft' ? { isPublished: false } : f === 'live' ? { isPublished: true, moderationStatus: 'ok' } : f === 'verified' ? { verified: true } : f === 'lapsed' ? { AND: [{ trialEndsAt: { lte: now } }, { OR: [{ subscriptionPaidUntil: null }, { subscriptionPaidUntil: { lte: now } }] }] } : {}) };
    const [rows, total] = await Promise.all([
        prisma.store.findMany({ where, include: { owner: { select: { id: true, name: true, email: true, accountStatus: true } }, _count: { select: { products: true } } }, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
        prisma.store.count({ where })
    ]);
    res.json({ data: { stores: rows.map(storeRow), page, pageSize, total, pages: Math.max(1, Math.ceil(total / pageSize)) } });
}));

router.get('/stores/:id', A.requirePermission(PM.STORES_VIEW), wrap(async (req, res) => {
    const store = await prisma.store.findUnique({ where: { id: req.params.id }, include: { owner: { select: { id: true, name: true, email: true, accountStatus: true } }, _count: { select: { products: true, orders: true } } } });
    if (!store) throw apiError('Store not found.', 404, 'NOT_FOUND');
    const [orders, payments] = await Promise.all([
        can(req, PM.ORDERS_VIEW) ? prisma.order.findMany({ where: { storeId: store.id, deletedAt: null }, orderBy: { createdAt: 'desc' }, take: 10 }) : null,
        can(req, PM.FINANCE_VIEW) || can(req, PM.SUBSCRIPTIONS_REVIEW) ? prisma.subscriptionPayment.findMany({ where: { storeId: store.id }, orderBy: { submittedAt: 'desc' }, take: 10 }) : null
    ]);
    res.json({ data: { store: { ...storeRow(store), description: store.description, contactEmail: store.contactEmail, phoneNumber: store.phoneNumber, address: store.address, orders: store._count.orders, moderatedAt: store.moderatedAt, badgeCommitmentMonths: store.badgeCommitmentMonths },
        orders: orders && orders.map((o) => ({ id: o.id, status: o.status, total: money(o.total), createdAt: o.createdAt })),
        payments: payments && payments.map((p) => ({ id: p.id, status: p.status, amount: money(p.amount), periodMonths: p.periodMonths, submittedAt: p.submittedAt })) } });
}));

router.put('/stores/:id/moderation', A.requirePermission(PM.STORES_MANAGE), wrap(async (req, res) => {
    const status = req.body && req.body.status;
    if (!['ok', 'restricted'].includes(status)) throw apiError('Status must be ok or restricted.', 400);
    const note = String((req.body && req.body.note) || '').trim().slice(0, 500);
    if (status === 'restricted' && note.length < 3) throw apiError('Give a reason. It is recorded and the owner is told.', 400, 'REASON_REQUIRED');
    const store = await prisma.store.findUnique({ where: { id: req.params.id } });
    if (!store) throw apiError('Store not found.', 404, 'NOT_FOUND');
    if ((store.moderationStatus || 'ok') === status) throw apiError('The store is already in that state.', 409);
    const updated = await prisma.store.update({ where: { id: store.id }, data: { moderationStatus: status, moderationNote: status === 'restricted' ? note : '', moderatedAt: new Date(), moderatedBy: req.staff.id } });
    await clearPublicCaches();
    if (store.ownerId) await createNotification({ userId: store.ownerId, type: 'subscription', title: status === 'restricted' ? 'Your store has been restricted' : 'Your store is back on the marketplace', body: status === 'restricted' ? `Shoppers cannot see your store right now. Reason: ${note}. Contact NextaStore support if you think this is a mistake.` : 'Your store was reviewed and is visible to shoppers again.', link: '/dashboard' });
    await A.audit(req, status === 'restricted' ? 'store.restricted' : 'store.restored', 'store', store.id, { targetUserId: store.ownerId, metadata: { note: note || undefined } });
    res.json({ data: { id: updated.id, moderationStatus: updated.moderationStatus, moderationNote: updated.moderationNote } });
}));

// ---- Products ----------------------------------------------------------------------------------------------------------------------------
router.get('/products', A.requirePermission(PM.PRODUCTS_VIEW), wrap(async (req, res) => {
    const { page, pageSize } = pageOf(req);
    const q = String(req.query.q || '').trim().slice(0, 100);
    const where = { deletedAt: null, ...(req.query.storeId ? { storeId: String(req.query.storeId) } : {}), ...(req.query.filter === 'restricted' ? { moderationStatus: 'restricted' } : {}),
        ...(q ? { OR: [{ name: { contains: q, mode: 'insensitive' } }, { id: { equals: q } }] } : {}) };
    const [rows, total] = await Promise.all([
        prisma.product.findMany({ where, include: { store: { select: { id: true, name: true, slug: true } } }, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
        prisma.product.count({ where })
    ]);
    res.json({ data: { products: rows.map((p) => ({ id: p.id, name: p.name, price: money(p.price), category: p.category, stock: p.stock, image: p.image || (Array.isArray(p.images) ? p.images[0] : null) || null, moderationStatus: p.moderationStatus || 'ok', moderationNote: p.moderationNote || '', store: p.store, createdAt: p.createdAt })), page, pageSize, total, pages: Math.max(1, Math.ceil(total / pageSize)) } });
}));

router.put('/products/:id/moderation', A.requirePermission(PM.PRODUCTS_MODERATE), wrap(async (req, res) => {
    const status = req.body && req.body.status;
    if (!['ok', 'restricted'].includes(status)) throw apiError('Status must be ok or restricted.', 400);
    const note = String((req.body && req.body.note) || '').trim().slice(0, 500);
    if (status === 'restricted' && note.length < 3) throw apiError('Give a reason. It is recorded and the seller is told.', 400, 'REASON_REQUIRED');
    const product = await prisma.product.findUnique({ where: { id: req.params.id }, include: { store: { select: { id: true, ownerId: true, name: true } } } });
    if (!product || product.deletedAt) throw apiError('Product not found.', 404, 'NOT_FOUND');
    if ((product.moderationStatus || 'ok') === status) throw apiError('The product is already in that state.', 409);
    await prisma.product.update({ where: { id: product.id }, data: { moderationStatus: status, moderationNote: status === 'restricted' ? note : '', moderatedAt: new Date(), moderatedBy: req.staff.id } });
    await clearPublicCaches();
    if (product.store.ownerId) await createNotification({ userId: product.store.ownerId, type: 'subscription', title: status === 'restricted' ? 'A listing was removed from the marketplace' : 'A listing is visible again', body: status === 'restricted' ? `"${product.name}" is hidden from shoppers. Reason: ${note}.` : `"${product.name}" was reviewed and is visible to shoppers again.`, link: '/dashboard' });
    await A.audit(req, status === 'restricted' ? 'product.restricted' : 'product.restored', 'product', product.id, { targetUserId: product.store.ownerId, metadata: { name: product.name, note: note || undefined } });
    res.json({ data: { id: product.id, moderationStatus: status } });
}));

// ---- Orders ----------------------------------------------------------------------------------------------------------------------------
const orderRow = (o) => ({ id: o.id, status: o.status, paymentStatus: o.paymentStatus, total: money(o.total), customerName: o.customerName, fulfillmentMethod: o.fulfillmentMethod, flaggedAt: o.flaggedAt, flagReason: o.flagReason, cancelledAt: o.cancelledAt, createdAt: o.createdAt, store: o.store ? { id: o.store.id, name: o.store.name, slug: o.store.slug } : null, reports: o._count ? o._count.reports : undefined });

router.get('/orders', A.requirePermission(PM.ORDERS_VIEW), wrap(async (req, res) => {
    const { page, pageSize } = pageOf(req);
    const q = String(req.query.q || '').trim().slice(0, 100);
    const where = { deletedAt: null, ...(req.query.storeId ? { storeId: String(req.query.storeId) } : {}),
        ...(['pending', 'processing', 'shipped', 'delivered', 'cancelled'].includes(req.query.status) ? { status: req.query.status } : {}),
        ...(req.query.flagged === '1' ? { flaggedAt: { not: null } } : {}),
        ...(q ? { OR: [{ id: { equals: q.toUpperCase() } }, { id: { equals: q } }, { customerName: { contains: q, mode: 'insensitive' } }, { customerPhone: { contains: q } }] } : {}) };
    const [rows, total] = await Promise.all([
        prisma.order.findMany({ where, include: { store: { select: { id: true, name: true, slug: true } }, _count: { select: { reports: true } } }, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
        prisma.order.count({ where })
    ]);
    res.json({ data: { orders: rows.map(orderRow), page, pageSize, total, pages: Math.max(1, Math.ceil(total / pageSize)) } });
}));

router.get('/orders/:id', A.requirePermission(PM.ORDERS_VIEW), wrap(async (req, res) => {
    const o = await prisma.order.findUnique({ where: { id: req.params.id }, include: { store: { select: { id: true, name: true, slug: true } }, buyer: { select: { id: true, name: true, email: true } }, items: true, reports: { include: { reporter: { select: { id: true, name: true } } } } } });
    if (!o || o.deletedAt) throw apiError('Order not found.', 404, 'NOT_FOUND');
    res.json({ data: { ...orderRow(o), customerPhone: o.customerPhone, deliveryAddress: o.deliveryAddress, paymentMethod: o.paymentMethod, cancelReason: o.cancelReason, buyer: o.buyer,
        items: (o.items || []).map((i) => ({ id: i.id, name: i.productName || '', quantity: i.quantity, price: money(i.unitPrice) })),
        reports: (o.reports || []).map((r) => ({ id: r.id, reason: r.reason, reviewedAt: r.reviewedAt, reporter: r.reporter, createdAt: r.createdAt })) } });
}));

router.put('/orders/:id/clear-flag', A.requirePermission(PM.ORDERS_MANAGE), wrap(async (req, res) => {
    const note = String((req.body && req.body.note) || '').trim().slice(0, 300);
    if (note.length < 3) throw apiError('Write a short note about why the flag is being cleared.', 400, 'REASON_REQUIRED');
    const o = await prisma.order.findUnique({ where: { id: req.params.id } });
    if (!o || o.deletedAt) throw apiError('Order not found.', 404, 'NOT_FOUND');
    if (!o.flaggedAt) throw apiError('This order is not flagged.', 409);
    await prisma.order.update({ where: { id: o.id }, data: { flaggedAt: null, flagReason: null } });
    await A.audit(req, 'order.flag_cleared', 'order', o.id, { metadata: { note, previousReason: o.flagReason || undefined } });
    res.json({ data: { ok: true } });
}));

// ---- Buyer reports -----------------------------------------------------------------------------------------------------------------------
router.get('/reports', A.requirePermission(PM.REPORTS_REVIEW), wrap(async (req, res) => {
    const reports = await prisma.orderReport.findMany({
        where: req.query.status === 'open' ? { reviewedAt: null } : req.query.status === 'reviewed' ? { reviewedAt: { not: null } } : {},
        include: { order: { select: { id: true, customerName: true, status: true, total: true, flaggedAt: true, flagReason: true, fulfillmentMethod: true, store: { select: { id: true, name: true, slug: true } } } }, reporter: { select: { id: true, name: true, email: true } } },
        orderBy: { createdAt: 'desc' }, take: 150
    });
    res.json({ data: reports.map((r) => ({ ...r, order: r.order && { ...r.order, total: money(r.order.total) } })) });
}));

router.put('/reports/:id/review', A.requirePermission(PM.REPORTS_REVIEW), wrap(async (req, res) => {
    const existing = await prisma.orderReport.findUnique({ where: { id: req.params.id } });
    if (!existing) throw apiError('Report not found.', 404, 'NOT_FOUND');
    if (existing.reviewedAt) throw apiError('This report was already reviewed.', 409);
    const report = await prisma.orderReport.update({ where: { id: existing.id }, data: { reviewedAt: new Date(), reviewedBy: req.staff.id } });
    await A.audit(req, 'report.reviewed', 'order_report', report.id, { targetUserId: existing.reporterId });
    res.json({ data: report });
}));

module.exports = router;
