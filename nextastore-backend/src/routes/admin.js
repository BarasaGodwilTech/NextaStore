const express = require('express');
const bcrypt = require('bcryptjs');
const prisma = require('../prisma');
const config = require('../config');
const { apiError } = require('../utils');
const { issueToken } = require('../verification');
const { sendMail } = require('../mailer');
const { requireAuth, requireAdminPermission, requireAnyAdminPermission, hasAdminPermission, isSuperAdmin, ADMIN_PERMISSIONS } = require('../middleware');
const { createNotification, getPlatformSettings, recordAdminAudit, subscriptionInfo, SUBSCRIPTION_PRICE_UGX } = require('../helpers');
const { removeAllSubscriptionsForUser } = require('../push');
const presence = require('../presence');
const { validateBody, platformSettingsSchema, paymentMethodCreateSchema, paymentMethodUpdateSchema, adminUserUpdateSchema, adminRoleSchema, followUpSchema } = require('../validation');

const router = express.Router();

const ALL_ADMIN_PERMISSIONS = Object.values(ADMIN_PERMISSIONS);

function serializePayment(p) {
    return { ...p, amount: Number(p.amount) };
}

function sanitizeUser(user) {
    return {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        accountStatus: user.accountStatus || 'active',
        adminLevel: user.adminLevel || 'standard',
        adminRole: user.adminRole ? {
            id: user.adminRole.id,
            name: user.adminRole.name,
            permissions: user.adminRole.permissions || []
        } : null,
        emailVerified: !!user.emailVerifiedAt,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
        store: user.store ? {
            id: user.store.id,
            name: user.store.name,
            slug: user.store.slug,
            subscription: subscriptionInfo(user.store),
            verified: !!user.store.verified && !!subscriptionInfo(user.store)?.isPaid,
            badgeCommitmentMonths: user.store.badgeCommitmentMonths || 0
        } : null
    };
}

async function loadUserForAdmin(id) {
    return prisma.user.findUnique({
        where: { id },
        include: { adminRole: true, store: true }
    });
}

router.get('/overview', requireAuth, requireAdminPermission(ADMIN_PERMISSIONS.DASHBOARD_VIEW), async (req, res, next) => {
    try {
        // Base headline numbers (accounts, sellers, suspended, stores) are
        // useful context for every admin. The rest each belong to a module
        // with its own permission (payments, reports, follow-ups, other
        // admins) — an admin who can't open that module shouldn't see its
        // count either, so those queries are skipped and the field omitted
        // (not just zeroed, which would read as "none pending").
        const canPayments = hasPermission(req.user, ADMIN_PERMISSIONS.SUBSCRIPTIONS_REVIEW);
        const canReports = hasPermission(req.user, ADMIN_PERMISSIONS.REPORTS_REVIEW);
        const canFollowUps = hasPermission(req.user, ADMIN_PERMISSIONS.FOLLOWUPS_MANAGE);
        const canAdmins = isSuperAdmin(req.user) || hasPermission(req.user, ADMIN_PERMISSIONS.ADMINS_MANAGE);

        const [users, sellers, suspended, stores, admins, openReports, pendingPayments, openFollowUps] = await Promise.all([
            prisma.user.count(),
            prisma.user.count({ where: { role: 'seller' } }),
            prisma.user.count({ where: { accountStatus: 'suspended' } }),
            prisma.store.count({ where: { deletedAt: null } }),
            canAdmins ? prisma.user.count({ where: { role: 'admin' } }) : null,
            canReports ? prisma.orderReport.count({ where: { reviewedAt: null } }) : null,
            canPayments ? prisma.subscriptionPayment.count({ where: { status: 'pending' } }) : null,
            canFollowUps ? prisma.adminFollowUp.count({ where: { status: { in: ['open', 'in_progress'] } } }) : null
        ]);
        res.json({ data: { users, sellers, admins, suspended, openReports, pendingPayments, openFollowUps, stores } });
    } catch (err) { next(err); }
});

router.get('/users', requireAuth, requireAdminPermission(ADMIN_PERMISSIONS.USERS_VIEW), async (req, res, next) => {
    try {
        const page = Math.max(1, Number(req.query.page || 1));
        const pageSize = Math.min(50, Math.max(10, Number(req.query.pageSize || 20)));
        const search = String(req.query.search || '').trim();
        const role = ['buyer', 'seller', 'admin'].includes(req.query.role) ? req.query.role : undefined;
        const accountStatus = ['active', 'suspended'].includes(req.query.accountStatus) ? req.query.accountStatus : undefined;
        const where = {
            ...(role ? { role } : {}),
            ...(accountStatus ? { accountStatus } : {}),
            ...(search ? { OR: [
                { name: { contains: search, mode: 'insensitive' } },
                { email: { contains: search, mode: 'insensitive' } }
            ] } : {})
        };
        const [rows, total] = await Promise.all([
            prisma.user.findMany({ where, include: { adminRole: true, store: true }, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
            prisma.user.count({ where })
        ]);
        res.json({ data: { users: rows.map(sanitizeUser), page, pageSize, total, pages: Math.ceil(total / pageSize) } });
    } catch (err) { next(err); }
});

router.get('/users/:id', requireAuth, requireAdminPermission(ADMIN_PERMISSIONS.USERS_VIEW), async (req, res, next) => {
    try {
        const user = await loadUserForAdmin(req.params.id);
        if (!user) throw apiError('User not found.', 404);
        // Follow-ups and the audit trail are separate modules with their own
        // permissions: being allowed to open an account must not also
        // reveal them.
        const [followUps, audit] = await Promise.all([
            hasPermission(req.user, ADMIN_PERMISSIONS.FOLLOWUPS_MANAGE)
                ? prisma.adminFollowUp.findMany({ where: { relatedUserId: user.id }, orderBy: { createdAt: 'desc' }, take: 30 })
                : [],
            hasPermission(req.user, ADMIN_PERMISSIONS.AUDIT_VIEW)
                ? prisma.adminAuditLog.findMany({ where: { targetUserId: user.id }, orderBy: { createdAt: 'desc' }, take: 50, include: { actor: { select: { id: true, name: true, email: true } } } })
                : []
        ]);
        res.json({ data: { user: sanitizeUser(user), followUps, audit } });
    } catch (err) { next(err); }
});

router.put('/users/:id', requireAuth, requireAnyAdminPermission(ADMIN_PERMISSIONS.USERS_EDIT, ADMIN_PERMISSIONS.USERS_SUSPEND), validateBody(adminUserUpdateSchema), async (req, res, next) => {
    try {
        const target = await loadUserForAdmin(req.params.id);
        if (!target) throw apiError('User not found.', 404);
        const actor = req.user;
        const payload = req.body;

        // The console always sends every field, so "was this field asked to
        // change?" means "does it differ from what is stored". Each kind of
        // change then needs its own permission.
        const targetLevel = target.adminLevel || 'standard';
        const nameChanged = payload.name !== undefined && payload.name.trim() !== target.name;
        const emailChanged = payload.email !== undefined && payload.email.toLowerCase() !== target.email.toLowerCase();
        const roleChanged = payload.role !== undefined && payload.role !== target.role;
        const statusChanged = payload.accountStatus !== undefined && payload.accountStatus !== (target.accountStatus || 'active');
        const levelChanged = payload.adminLevel !== undefined && payload.adminLevel !== targetLevel;
        const adminRoleChanged = payload.adminRoleId !== undefined && (payload.adminRoleId || null) !== (target.adminRoleId || null);
        const touchesAdminAccess = target.role === 'admin' || payload.role === 'admin' || levelChanged || adminRoleChanged;
        const anyChange = nameChanged || emailChanged || roleChanged || statusChanged || levelChanged || adminRoleChanged;

        if (target.id === actor.id && payload.accountStatus === 'suspended') throw apiError('You cannot suspend your own account.');
        if (targetLevel === 'super_admin' && !isSuperAdmin(actor)) throw apiError('Only a super admin can edit another super admin.', 403);
        if ((nameChanged || emailChanged || roleChanged) && !hasPermission(actor, ADMIN_PERMISSIONS.USERS_EDIT)) {
            throw apiError('You do not have permission to edit account details.', 403);
        }
        if (statusChanged && !hasPermission(actor, ADMIN_PERMISSIONS.USERS_SUSPEND)) {
            throw apiError(payload.accountStatus === 'suspended' ? 'You do not have permission to suspend accounts.' : 'You do not have permission to reactivate accounts.', 403);
        }
        if (anyChange && touchesAdminAccess && !hasPermission(actor, ADMIN_PERMISSIONS.ADMINS_MANAGE)) {
            throw apiError('You do not have permission to manage administrator accounts.', 403);
        }
        if (payload.adminLevel === 'super_admin' && levelChanged && !isSuperAdmin(actor)) throw apiError('Only a super admin can grant super-admin access.', 403);
        if (payload.adminRoleId && payload.role && payload.role !== 'admin') throw apiError('An admin role can only be assigned to an administrator.');
        if (payload.role === 'buyer' && target.store) throw apiError('This seller already has a store. Keep the account as a seller or remove its store first.');

        // The platform must never be left without anyone who can manage
        // administrators, so the last active super admin cannot be demoted,
        // switched to another account type or suspended.
        const removesSuperAdmin = targetLevel === 'super_admin' && target.role === 'admin' && (
            payload.adminLevel === 'standard' || (payload.role !== undefined && payload.role !== 'admin') || (statusChanged && payload.accountStatus === 'suspended')
        );
        if (removesSuperAdmin) {
            const others = await prisma.user.count({ where: { role: 'admin', adminLevel: 'super_admin', accountStatus: 'active', id: { not: target.id } } });
            if (others === 0) throw apiError('There must always be at least one active super administrator.', 409);
        }

        const data = {};
        if (payload.name !== undefined) data.name = payload.name.trim();
        if (payload.email !== undefined && payload.email.toLowerCase() !== target.email.toLowerCase()) {
            data.email = payload.email.toLowerCase();
            data.emailVerifiedAt = null;
        }
        if (payload.role !== undefined) data.role = payload.role;
        if (payload.accountStatus !== undefined) data.accountStatus = payload.accountStatus;
        if (payload.role === 'admin' || target.role === 'admin') {
            if (payload.adminLevel !== undefined) data.adminLevel = payload.adminLevel;
            if (payload.adminRoleId !== undefined) {
                if (payload.adminRoleId) {
                    const role = await prisma.adminRole.findUnique({ where: { id: payload.adminRoleId } });
                    if (!role) throw apiError('Selected admin role was not found.', 404);
                    // Handing out a role is handing out its permissions, so an
                    // admin can only assign roles that hold nothing they lack
                    // themselves (otherwise "manage admins" is a way to become
                    // a super admin).
                    if (adminRoleChanged && ungrantable(actor, role.permissions || []).length) {
                        throw apiError('You can only assign roles whose permissions you hold yourself.', 403);
                    }
                }
                data.adminRoleId = payload.adminRoleId;
            }
        }
        if (payload.role && payload.role !== 'admin') {
            data.adminLevel = 'standard';
            data.adminRoleId = null;
        }

        const updated = await prisma.user.update({ where: { id: target.id }, data, include: { adminRole: true, store: true } });
        // A suspended account can no longer call the API, but its phone would
        // still get message and order previews from the push service.
        if (payload.accountStatus === 'suspended' && target.accountStatus !== 'suspended') await removeAllSubscriptionsForUser(target.id);
        // A suspended account must not keep showing as online.
        if (payload.accountStatus === 'suspended' && target.accountStatus !== 'suspended') presence.disconnectUser(target.id, 'session-ended');
        await recordAdminAudit({ actorId: actor.id, action: 'user.updated', targetType: 'user', targetId: updated.id, targetUserId: updated.id, metadata: { fields: Object.keys(data) } });
        res.json({ data: sanitizeUser(updated) });
    } catch (err) { next(err); }
});

function hasPermission(user, permission) { return hasAdminPermission(user, permission); }

// Permissions in `wanted` that `actor` does not hold themselves. A super admin
// holds everything, so for them the answer is always empty.
function ungrantable(actor, wanted) {
    if (isSuperAdmin(actor)) return [];
    return (wanted || []).filter((p) => !hasPermission(actor, p));
}

router.post('/users/:id/password-reset', requireAuth, requireAdminPermission(ADMIN_PERMISSIONS.USERS_PASSWORD_RESET), async (req, res, next) => {
    try {
        const target = await loadUserForAdmin(req.params.id);
        if (!target) throw apiError('User not found.', 404);
        // Same protection as editing: a support-level admin must not be able
        // to trigger recovery on the accounts that sit above them.
        if (target.adminLevel === 'super_admin' && !isSuperAdmin(req.user)) throw apiError('Only a super admin can reset another super admin\'s password.', 403);
        if (target.role === 'admin' && !hasPermission(req.user, ADMIN_PERMISSIONS.ADMINS_MANAGE)) throw apiError('You do not have permission to manage administrator accounts.', 403);
        const token = await issueToken(target.id, 'password_reset');
        const resetUrl = `${config.frontendUrl}/forgot-password.html?token=${encodeURIComponent(token)}`;
        let emailed = true;
        try {
            await sendMail({
                to: target.email,
                subject: 'Your NextaStore password reset',
                text: `A NextaStore administrator requested a password reset for your account. Reset your password here: ${resetUrl}\n\nThis link expires in 1 hour.`
            });
        } catch (mailErr) {
            emailed = false;
            console.error('Admin password reset email failed:', mailErr);
        }
        await recordAdminAudit({ actorId: req.user.id, action: 'user.password_reset_requested', targetType: 'user', targetId: target.id, targetUserId: target.id, metadata: { emailed } });
        res.json({ data: { emailed, message: emailed ? 'Password reset instructions were sent to the user.' : 'The reset email could not be sent. A reset link was generated for secure follow-up.', resetUrl: isSuperAdmin(req.user) ? resetUrl : undefined } });
    } catch (err) { next(err); }
});

router.get('/administrators', requireAuth, requireAnyAdminPermission(ADMIN_PERMISSIONS.FOLLOWUPS_MANAGE, ADMIN_PERMISSIONS.ADMINS_MANAGE), async (req, res, next) => {
    try {
        const admins = await prisma.user.findMany({ where: { role: 'admin', accountStatus: 'active' }, select: { id: true, name: true, email: true, adminLevel: true, adminRole: { select: { id: true, name: true } } }, orderBy: { name: 'asc' } });
        res.json({ data: admins });
    } catch (err) { next(err); }
});

router.get('/roles', requireAuth, requireAnyAdminPermission(ADMIN_PERMISSIONS.ROLES_MANAGE, ADMIN_PERMISSIONS.ADMINS_MANAGE), async (req, res, next) => {
    try {
        const roles = await prisma.adminRole.findMany({ include: { _count: { select: { users: true } } }, orderBy: { name: 'asc' } });
        res.json({ data: { roles, permissions: ALL_ADMIN_PERMISSIONS } });
    } catch (err) { next(err); }
});

router.post('/roles', requireAuth, requireAdminPermission(ADMIN_PERMISSIONS.ROLES_MANAGE), validateBody(adminRoleSchema), async (req, res, next) => {
    try {
        const permissions = req.body.permissions.filter(p => ALL_ADMIN_PERMISSIONS.includes(p));
        if (!permissions.length) throw apiError('Select at least one permission for this admin role.');
        if (ungrantable(req.user, permissions).length) throw apiError('You can only grant permissions you hold yourself.', 403);
        const role = await prisma.adminRole.create({ data: { name: req.body.name, description: req.body.description, permissions, createdById: req.user.id } });
        await recordAdminAudit({ actorId: req.user.id, action: 'admin_role.created', targetType: 'admin_role', targetId: role.id, metadata: { name: role.name, permissions } });
        res.status(201).json({ data: role });
    } catch (err) { next(err); }
});

router.put('/roles/:id', requireAuth, requireAdminPermission(ADMIN_PERMISSIONS.ROLES_MANAGE), validateBody(adminRoleSchema), async (req, res, next) => {
    try {
        const permissions = req.body.permissions.filter(p => ALL_ADMIN_PERMISSIONS.includes(p));
        if (!permissions.length) throw apiError('Select at least one permission for this admin role.');
        const existing = await prisma.adminRole.findUnique({ where: { id: req.params.id } });
        if (!existing) throw apiError('Admin role not found.', 404);
        // Neither the new permission set nor the one being replaced may go
        // beyond the editor's own: otherwise editing a stronger role (or
        // your own) is a way to hand yourself more than you were given.
        if (ungrantable(req.user, permissions).length || ungrantable(req.user, existing.permissions).length) {
            throw apiError('You can only edit roles made up of permissions you hold yourself.', 403);
        }
        const role = await prisma.adminRole.update({ where: { id: req.params.id }, data: { name: req.body.name, description: req.body.description, permissions } });
        await recordAdminAudit({ actorId: req.user.id, action: 'admin_role.updated', targetType: 'admin_role', targetId: role.id, metadata: { name: role.name, permissions } });
        res.json({ data: role });
    } catch (err) { next(err); }
});

router.delete('/roles/:id', requireAuth, requireAdminPermission(ADMIN_PERMISSIONS.ROLES_MANAGE), async (req, res, next) => {
    try {
        const role = await prisma.adminRole.findUnique({ where: { id: req.params.id }, include: { _count: { select: { users: true } } } });
        if (!role) throw apiError('Admin role not found.', 404);
        if (ungrantable(req.user, role.permissions).length) throw apiError('You can only delete roles made up of permissions you hold yourself.', 403);
        if (role._count.users > 0) throw apiError('This role is still assigned to administrators. Reassign them first.');
        await prisma.adminRole.delete({ where: { id: role.id } });
        await recordAdminAudit({ actorId: req.user.id, action: 'admin_role.deleted', targetType: 'admin_role', targetId: role.id, metadata: { name: role.name } });
        res.json({ data: { success: true } });
    } catch (err) { next(err); }
});

router.get('/follow-ups', requireAuth, requireAdminPermission(ADMIN_PERMISSIONS.FOLLOWUPS_MANAGE), async (req, res, next) => {
    try {
        const status = ['open', 'in_progress', 'done', 'cancelled'].includes(req.query.status) ? req.query.status : undefined;
        const rows = await prisma.adminFollowUp.findMany({
            where: status ? { status } : {},
            include: { relatedUser: { select: { id: true, name: true, email: true } }, assignedTo: { select: { id: true, name: true, email: true } }, adminRole: { select: { id: true, name: true } } },
            orderBy: [{ status: 'asc' }, { dueAt: 'asc' }, { createdAt: 'desc' }], take: 200
        });
        res.json({ data: rows });
    } catch (err) { next(err); }
});

router.post('/follow-ups', requireAuth, requireAdminPermission(ADMIN_PERMISSIONS.FOLLOWUPS_MANAGE), validateBody(followUpSchema), async (req, res, next) => {
    try {
        const payload = req.body;
        if (payload.assignedToId) {
            const assignee = await loadUserForAdmin(payload.assignedToId);
            if (!assignee || assignee.role !== 'admin') throw apiError('Follow-ups can only be assigned to administrators.');
        }
        const row = await prisma.adminFollowUp.create({ data: {
            title: payload.title,
            note: payload.note || '',
            status: payload.status || 'open',
            dueAt: payload.dueAt ? new Date(payload.dueAt) : null,
            relatedUserId: payload.relatedUserId || null,
            assignedToId: payload.assignedToId || null,
            adminRoleId: payload.adminRoleId || null
        }, include: { relatedUser: { select: { id: true, name: true, email: true } }, assignedTo: { select: { id: true, name: true, email: true } } } });
        await recordAdminAudit({ actorId: req.user.id, action: 'follow_up.created', targetType: 'follow_up', targetId: row.id, targetUserId: row.relatedUserId, metadata: { title: row.title } });
        res.status(201).json({ data: row });
    } catch (err) { next(err); }
});

router.put('/follow-ups/:id', requireAuth, requireAdminPermission(ADMIN_PERMISSIONS.FOLLOWUPS_MANAGE), validateBody(followUpSchema), async (req, res, next) => {
    try {
        const payload = req.body;
        const current = await prisma.adminFollowUp.findUnique({ where: { id: req.params.id } });
        if (!current) throw apiError('Follow-up not found.', 404);
        const data = {};
        for (const key of ['title', 'note', 'status', 'relatedUserId', 'assignedToId', 'adminRoleId']) if (payload[key] !== undefined) data[key] = payload[key] || null;
        if (payload.dueAt !== undefined) data.dueAt = payload.dueAt ? new Date(payload.dueAt) : null;
        if (payload.status === 'done') data.completedAt = new Date();
        else if (payload.status) data.completedAt = null;
        if (data.assignedToId) {
            const assignee = await loadUserForAdmin(data.assignedToId);
            if (!assignee || assignee.role !== 'admin') throw apiError('Follow-ups can only be assigned to administrators.');
        }
        const row = await prisma.adminFollowUp.update({ where: { id: current.id }, data, include: { relatedUser: { select: { id: true, name: true, email: true } }, assignedTo: { select: { id: true, name: true, email: true } } } });
        await recordAdminAudit({ actorId: req.user.id, action: 'follow_up.updated', targetType: 'follow_up', targetId: row.id, targetUserId: row.relatedUserId, metadata: { fields: Object.keys(data) } });
        res.json({ data: row });
    } catch (err) { next(err); }
});

router.get('/audit', requireAuth, requireAdminPermission(ADMIN_PERMISSIONS.AUDIT_VIEW), async (req, res, next) => {
    try {
        const rows = await prisma.adminAuditLog.findMany({ orderBy: { createdAt: 'desc' }, take: 200, include: { actor: { select: { id: true, name: true, email: true } }, targetUser: { select: { id: true, name: true, email: true } } } });
        res.json({ data: rows });
    } catch (err) { next(err); }
});

router.get('/reports', requireAuth, requireAdminPermission(ADMIN_PERMISSIONS.REPORTS_REVIEW), async (req, res, next) => {
    try {
        const reports = await prisma.orderReport.findMany({
            include: { order: { select: { id:true, customerName:true, customerPhone:true, status:true, total:true, flaggedAt:true, flagReason:true, fulfillmentMethod:true, store:{select:{id:true,name:true,slug:true}} } }, reporter: { select: { id:true, name:true, email:true } } },
            orderBy: { createdAt: 'desc' }, take: 100
        });
        res.json({ data: reports });
    } catch (err) { next(err); }
});

router.put('/reports/:id/review', requireAuth, requireAdminPermission(ADMIN_PERMISSIONS.REPORTS_REVIEW), async (req, res, next) => {
    try {
        const report = await prisma.orderReport.update({ where: { id:req.params.id }, data:{ reviewedAt:new Date(), reviewedBy:req.user.id } });
        await recordAdminAudit({ actorId: req.user.id, action: 'report.reviewed', targetType: 'order_report', targetId: report.id, metadata: {} });
        res.json({ data: report });
    } catch (err) { next(err); }
});

router.get('/subscription-payments', requireAuth, requireAdminPermission(ADMIN_PERMISSIONS.SUBSCRIPTIONS_REVIEW), async (req, res, next) => {
    try {
        const payments = await prisma.subscriptionPayment.findMany({
            include: { store: { select: { id: true, name: true, slug: true, ownerId: true, badgeCommitmentMonths: true, subscriptionPaidUntil: true, verified: true, owner: { select: { name: true, email: true } } } } },
            orderBy: [{ status: 'asc' }, { submittedAt: 'desc' }], take: 200
        });
        res.json({ data: payments.map(p => ({ ...serializePayment(p), store: p.store })) });
    } catch (err) { next(err); }
});

router.put('/subscription-payments/:id/approve', requireAuth, requireAdminPermission(ADMIN_PERMISSIONS.SUBSCRIPTIONS_REVIEW), async (req, res, next) => {
    try {
        const payment = await prisma.subscriptionPayment.findUnique({ where: { id: req.params.id }, include: { store: true } });
        if (!payment) throw apiError('Payment not found.', 404);
        if (payment.status !== 'pending') throw apiError('This payment was already reviewed.');

        const months = Number(payment.periodMonths || 1);
        const now = new Date();
        const existingPaidUntil = payment.store.subscriptionPaidUntil ? new Date(payment.store.subscriptionPaidUntil) : null;
        const wasAlreadyPaid = !!existingPaidUntil && existingPaidUntil.getTime() > now.getTime();
        const base = wasAlreadyPaid ? existingPaidUntil : now;
        base.setMonth(base.getMonth() + months);
        // The commitment counter follows the current continuous paid coverage.
        // Example: 3 months approved + another 3 months while active = 6 months
        // of commitment, which unlocks Verified Seller. A payment made after an
        // expired subscription starts a new commitment cycle.
        const priorCommitment = wasAlreadyPaid ? Number(payment.store.badgeCommitmentMonths || 0) : 0;
        const commitmentMonths = priorCommitment + months;
        const badgeEligible = commitmentMonths >= 6;

        const updatedStore = await prisma.$transaction(async tx => {
            await tx.subscriptionPayment.update({ where: { id: payment.id }, data: { status: 'approved', reviewedAt: now, reviewedBy: req.user.id } });
            return tx.store.update({ where: { id: payment.storeId }, data: { subscriptionStatus: 'active', subscriptionPaidUntil: base, badgeCommitmentMonths: commitmentMonths, verified: badgeEligible } });
        });

        await recordAdminAudit({ actorId: req.user.id, action: 'subscription_payment.approved', targetType: 'subscription_payment', targetId: payment.id, targetUserId: payment.store.ownerId, metadata: { months, amount: Number(payment.amount), commitmentMonths, badgeEligible } });
        if (payment.store.ownerId) {
            await createNotification({
                userId: payment.store.ownerId,
                type: 'subscription',
                title: 'Seller Pass confirmed',
                body: badgeEligible
                    ? `Your payment is confirmed. You now have ${commitmentMonths} months of active paid coverage and your ${commitmentMonths >= 24 ? 'Platinum Partner' : commitmentMonths >= 12 ? 'Gold Partner' : 'Verified Seller'} badge is live.`
                    : `Your ${months}-month payment is confirmed. You now have ${commitmentMonths} months covered. Add ${6 - commitmentMonths} more month${6 - commitmentMonths === 1 ? '' : 's'} while your pass is active to unlock Verified Seller.`,
                link: '/subscription.html'
            });
        }

        res.json({ data: { success: true, subscriptionPaidUntil: updatedStore.subscriptionPaidUntil, commitmentMonths, badgeEligible } });
    } catch (err) { next(err); }
});

router.put('/subscription-payments/:id/reject', requireAuth, requireAdminPermission(ADMIN_PERMISSIONS.SUBSCRIPTIONS_REVIEW), async (req, res, next) => {
    try {
        const note = String(req.body?.note || '').trim().slice(0, 500);
        const existing = await prisma.subscriptionPayment.findUnique({ where: { id: req.params.id }, include: { store: true } });
        if (!existing) throw apiError('Payment not found.', 404);
        if (existing.status !== 'pending') throw apiError('This payment was already reviewed.');
        const payment = await prisma.subscriptionPayment.update({ where: { id: req.params.id }, data: { status: 'rejected', reviewedAt: new Date(), reviewedBy: req.user.id, note } });
        await recordAdminAudit({ actorId: req.user.id, action: 'subscription_payment.rejected', targetType: 'subscription_payment', targetId: payment.id, targetUserId: existing.store.ownerId, metadata: { note: note || null } });
        if (existing.store.ownerId) await createNotification({ userId: existing.store.ownerId, type: 'subscription', title: 'Payment needs attention', body: note || 'We could not confirm that transaction reference. Please check the mobile-money receipt and submit it again.', link: '/subscription.html' });
        res.json({ data: serializePayment(payment) });
    } catch (err) { next(err); }
});

router.get('/settings', requireAuth, requireAdminPermission(ADMIN_PERMISSIONS.SETTINGS_MANAGE), async (req, res, next) => {
    try { res.json({ data: await getPlatformSettings() }); } catch (err) { next(err); }
});

router.put('/settings', requireAuth, requireAdminPermission(ADMIN_PERMISSIONS.SETTINGS_MANAGE), validateBody(platformSettingsSchema), async (req, res, next) => {
    try {
        const settings = await prisma.platformSettings.upsert({ where: { id: 'singleton' }, update: req.body, create: { id: 'singleton', ...req.body } });
        await recordAdminAudit({ actorId: req.user.id, action: 'platform_settings.updated', targetType: 'platform_settings', targetId: 'singleton', metadata: { fields: Object.keys(req.body) } });
        res.json({ data: settings });
    } catch (err) { next(err); }
});

// Payment-method catalog (see prisma schema PaymentMethod + GET
// /api/payments/methods, the public read side of this). Admin sees every
// row including disabled/test ones; the public route filters those out.
router.get('/payment-methods', requireAuth, requireAdminPermission(ADMIN_PERMISSIONS.SETTINGS_MANAGE), async (req, res, next) => {
    try {
        const methods = await prisma.paymentMethod.findMany({ orderBy: { sortOrder: 'asc' } });
        res.json({ data: methods });
    } catch (err) { next(err); }
});

router.post('/payment-methods', requireAuth, requireAdminPermission(ADMIN_PERMISSIONS.SETTINGS_MANAGE), validateBody(paymentMethodCreateSchema), async (req, res, next) => {
    try {
        const existing = await prisma.paymentMethod.findUnique({ where: { code: req.body.code } });
        if (existing) throw apiError('A payment method with that code already exists.', 409);
        const method = await prisma.paymentMethod.create({ data: req.body });
        await recordAdminAudit({ actorId: req.user.id, action: 'payment_method.created', targetType: 'payment_method', targetId: method.id, metadata: { code: method.code } });
        res.status(201).json({ data: method });
    } catch (err) { next(err); }
});

router.put('/payment-methods/:id', requireAuth, requireAdminPermission(ADMIN_PERMISSIONS.SETTINGS_MANAGE), validateBody(paymentMethodUpdateSchema), async (req, res, next) => {
    try {
        const existing = await prisma.paymentMethod.findUnique({ where: { id: req.params.id } });
        if (!existing) throw apiError('Payment method not found.', 404);
        const method = await prisma.paymentMethod.update({ where: { id: existing.id }, data: req.body });
        await recordAdminAudit({ actorId: req.user.id, action: 'payment_method.updated', targetType: 'payment_method', targetId: method.id, metadata: { fields: Object.keys(req.body) } });
        res.json({ data: method });
    } catch (err) { next(err); }
});

router.delete('/payment-methods/:id', requireAuth, requireAdminPermission(ADMIN_PERMISSIONS.SETTINGS_MANAGE), async (req, res, next) => {
    try {
        const existing = await prisma.paymentMethod.findUnique({ where: { id: req.params.id } });
        if (!existing) throw apiError('Payment method not found.', 404);
        await prisma.paymentMethod.delete({ where: { id: existing.id } });
        await recordAdminAudit({ actorId: req.user.id, action: 'payment_method.deleted', targetType: 'payment_method', targetId: existing.id, metadata: { code: existing.code } });
        res.json({ data: { ok: true } });
    } catch (err) { next(err); }
});

module.exports = router;
