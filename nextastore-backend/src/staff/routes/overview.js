'use strict';
/* Role-aware home page and analytics. Every block is gated by the permission that owns it; blocks you cannot see are omitted, never zeroed. */
const express = require('express');
const prisma = require('../../prisma');
const A = require('../auth');
const { hasPermission, PERMISSIONS: PM } = require('../permissions');
const { auditOut } = require('./team');

const router = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.get('/overview', A.requirePermission(PM.DASHBOARD_VIEW), wrap(async (req, res) => {
    const can = (p) => hasPermission(req.staff, p);
    const active = { status: { in: ['open', 'pending'] } };
    const day = new Date(Date.now() - 24 * 3600 * 1000);
    const [users, sellers, stores, restricted, newToday, pendingPayments, openReports, flaggedOrders, tAll, tMine, tUnassigned, tBreached, tUrgent, myFollowUps, pendingInvites, noMfa, recent] = await Promise.all([
        can(PM.USERS_VIEW) ? prisma.user.count() : null,
        can(PM.USERS_VIEW) ? prisma.user.count({ where: { role: 'seller' } }) : null,
        can(PM.STORES_VIEW) ? prisma.store.count({ where: { deletedAt: null, isPublished: true } }) : null,
        can(PM.STORES_VIEW) ? prisma.store.count({ where: { moderationStatus: 'restricted' } }) : null,
        can(PM.USERS_VIEW) ? prisma.user.count({ where: { createdAt: { gte: day } } }) : null,
        can(PM.SUBSCRIPTIONS_REVIEW) ? prisma.subscriptionPayment.count({ where: { status: 'pending' } }) : null,
        can(PM.REPORTS_REVIEW) ? prisma.orderReport.count({ where: { reviewedAt: null } }) : null,
        can(PM.ORDERS_VIEW) ? prisma.order.count({ where: { flaggedAt: { not: null }, deletedAt: null } }) : null,
        can(PM.TICKETS_VIEW) ? prisma.supportTicket.count({ where: active }) : null,
        can(PM.TICKETS_VIEW) ? prisma.supportTicket.count({ where: { ...active, assigneeId: req.staff.id } }) : null,
        can(PM.TICKETS_VIEW) ? prisma.supportTicket.count({ where: { ...active, assigneeId: null } }) : null,
        can(PM.TICKETS_VIEW) ? prisma.supportTicket.count({ where: { status: 'open', slaDueAt: { lt: new Date() } } }) : null,
        can(PM.TICKETS_VIEW) ? prisma.supportTicket.count({ where: { ...active, priority: 'urgent' } }) : null,
        can(PM.FOLLOWUPS_MANAGE) ? prisma.adminFollowUp.count({ where: { status: { in: ['open', 'in_progress'] }, assignedToId: req.staff.id } }) : null,
        can(PM.STAFF_MANAGE) ? prisma.staffAccount.count({ where: { status: 'invited' } }) : null,
        can(PM.SECURITY_MANAGE) ? prisma.staffAccount.count({ where: { status: 'active', mfaEnabledAt: null } }) : null,
        can(PM.AUDIT_VIEW) ? prisma.adminAuditLog.findMany({ orderBy: { createdAt: 'desc' }, take: 8, include: { actor: { select: { id: true, name: true, email: true } }, targetUser: { select: { id: true, name: true, email: true } } } }) : null
    ]);
    res.json({ data: {
        headline: { users, sellers, stores, restricted, newToday },
        attention: { pendingPayments, openReports, flaggedOrders, tickets: tAll === null ? null : { active: tAll, mine: tMine, unassigned: tUnassigned, breached: tBreached, urgent: tUrgent }, myFollowUps, pendingInvites, staffWithoutMfa: noMfa },
        recent: recent && recent.map(auditOut)
    } });
}));

// Daily series for the last 30 days (zero-filled) + monthly Seller Pass revenue for 6 months.
router.get('/analytics', A.requirePermission(PM.ANALYTICS_VIEW), wrap(async (req, res) => {
    const days = 30;
    const start = new Date(); start.setUTCHours(0, 0, 0, 0); start.setUTCDate(start.getUTCDate() - (days - 1));
    const monthStart = new Date(); monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0); monthStart.setUTCMonth(monthStart.getUTCMonth() - 5);
    const [signups, orders, revenue] = await Promise.all([
        prisma.$queryRaw`SELECT to_char(date_trunc('day', "createdAt"), 'YYYY-MM-DD') AS d, count(*)::int AS n FROM "User" WHERE "createdAt" >= ${start} GROUP BY 1`,
        prisma.$queryRaw`SELECT to_char(date_trunc('day', "createdAt"), 'YYYY-MM-DD') AS d, count(*)::int AS n, COALESCE(sum("total"), 0)::float8 AS total FROM "Order" WHERE "createdAt" >= ${start} AND "deletedAt" IS NULL GROUP BY 1`,
        prisma.$queryRaw`SELECT to_char(date_trunc('month', "reviewedAt"), 'YYYY-MM') AS m, COALESCE(sum("amount"), 0)::float8 AS total, count(*)::int AS n FROM "SubscriptionPayment" WHERE "status" = 'approved' AND "reviewedAt" >= ${monthStart} GROUP BY 1`
    ]);
    const key = (d) => d.toISOString().slice(0, 10);
    const sMap = new Map(signups.map((r) => [r.d, r.n])), oMap = new Map(orders.map((r) => [r.d, r]));
    const series = [];
    for (let i = 0; i < days; i++) { const d = new Date(start); d.setUTCDate(start.getUTCDate() + i); const k = key(d); series.push({ date: k, signups: sMap.get(k) || 0, orders: (oMap.get(k) || {}).n || 0, orderValue: (oMap.get(k) || {}).total || 0 }); }
    const rMap = new Map(revenue.map((r) => [r.m, r]));
    const months = [];
    for (let i = 0; i < 6; i++) { const d = new Date(monthStart); d.setUTCMonth(monthStart.getUTCMonth() + i); const k = d.toISOString().slice(0, 7); months.push({ month: k, revenue: (rMap.get(k) || {}).total || 0, payments: (rMap.get(k) || {}).n || 0 }); }
    res.json({ data: { series, months } });
}));

module.exports = router;
