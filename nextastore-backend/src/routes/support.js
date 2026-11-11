'use strict';
/*
 * The shopper side of the support desk, and the public read of staff announcements.
 *
 *   POST /api/support/tickets            open a ticket (signed in, or a guest with name + email)
 *   GET  /api/support/tickets            my tickets (signed in)
 *   GET  /api/support/tickets/:id        one of my tickets and its public thread (internal notes are never returned)
 *   POST /api/support/tickets/:id/messages   reply
 *   GET  /api/announcements/active       notices staff have published, filtered for the viewer
 *
 * Staff work these tickets in the Staff Console (src/staff/routes/support.js). A guest cannot read a ticket back: they
 * only get a reference number and the answer by email.
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const prisma = require('../prisma');
const { apiError } = require('../utils');
const { requireAuth, optionalAuth } = require('../middleware');
const SUP = require('../staff/support');

const router = express.Router();
const announcementsRouter = express.Router();

const openLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 8, standardHeaders: true, legacyHeaders: false, message: { message: 'You have opened several tickets recently. Please wait a little before opening another.' } });
const replyLimiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false, message: { message: 'Too many messages. Please wait a few minutes.' } });
const clean = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max);
const pub = (t) => ({ id: t.id, number: t.number, subject: t.subject, category: t.category, status: t.status, createdAt: t.createdAt, updatedAt: t.updatedAt, lastMessageAt: t.lastMessageAt });

router.post('/tickets', openLimiter, optionalAuth, async (req, res, next) => {
    try {
        const b = req.body || {};
        const subject = clean(b.subject, 160), body = clean(b.body, 5000);
        if (subject.length < 3) throw apiError('Please give your question a short title.', 400);
        if (body.length < 10) throw apiError('Please tell us a bit more so we can help.', 400);
        let name, email;
        if (req.user) { name = req.user.name; email = req.user.email; }
        else {
            name = clean(b.name, 80); email = clean(b.email, 160).toLowerCase();
            if (name.length < 2) throw apiError('Please enter your name.', 400);
            if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw apiError('Please enter a valid email address so we can reply.', 400);
        }
        const category = SUP.CATEGORIES.includes(b.category) ? b.category : 'general';
        // Customers never choose their own priority (that would make everything urgent). Payment and account problems start higher.
        const priority = ['payments', 'account'].includes(category) ? 'high' : 'normal';
        const t = await prisma.supportTicket.create({ data: {
            subject, category, priority, requesterId: req.user ? req.user.id : null, requesterName: name, requesterEmail: email, source: 'web',
            relatedOrderId: b.orderId ? clean(b.orderId, 40) : null, slaDueAt: SUP.slaDueFrom(priority),
            messages: { create: { authorKind: 'customer', authorName: name, body } }
        } });
        res.status(201).json({ data: { ...pub(t), message: `Thanks. Your reference is #${t.number}. We will reply by email${req.user ? ' and here' : ''}.` } });
    } catch (err) { next(err); }
});

router.get('/tickets', requireAuth, async (req, res, next) => {
    try {
        const rows = await prisma.supportTicket.findMany({ where: { requesterId: req.user.id }, orderBy: { lastMessageAt: 'desc' }, take: 50 });
        res.json({ data: rows.map(pub) });
    } catch (err) { next(err); }
});

async function mine(req) {
    const t = await prisma.supportTicket.findFirst({ where: { id: String(req.params.id), requesterId: req.user.id } });
    if (!t) throw apiError('Ticket not found.', 404);   // same answer for "not yours" and "does not exist"
    return t;
}

router.get('/tickets/:id', requireAuth, async (req, res, next) => {
    try {
        const t = await mine(req);
        const messages = await prisma.supportTicketMessage.findMany({ where: { ticketId: t.id, isInternal: false }, orderBy: { createdAt: 'asc' }, include: { authorStaff: { select: { name: true } } } });
        res.json({ data: { ...pub(t), messages: messages.map((m) => ({ id: m.id, from: m.authorKind === 'staff' ? 'support' : 'you', author: m.authorKind === 'staff' ? `${m.authorStaff ? m.authorStaff.name.split(' ')[0] : 'Support'} (NextaStore Support)` : 'You', body: m.body, at: m.createdAt })) } });
    } catch (err) { next(err); }
});

router.post('/tickets/:id/messages', replyLimiter, requireAuth, async (req, res, next) => {
    try {
        const t = await mine(req);
        const body = clean(req.body && req.body.body, 5000);
        if (body.length < 2) throw apiError('Write a message first.', 400);
        if (t.status === 'closed') throw apiError('This ticket is closed. Please open a new one.', 409);
        await prisma.supportTicketMessage.create({ data: { ticketId: t.id, authorKind: 'customer', authorName: req.user.name, body } });
        // A reply reopens a resolved ticket and restarts its answer clock.
        await prisma.supportTicket.update({ where: { id: t.id }, data: { lastMessageAt: new Date(), ...(t.status === 'resolved' || t.status === 'pending' ? { status: 'open', resolvedAt: null, slaDueAt: SUP.slaDueFrom(t.priority) } : {}) } });
        res.status(201).json({ data: { ok: true } });
    } catch (err) { next(err); }
});

const annLimiter = rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false });
announcementsRouter.get('/active', annLimiter, optionalAuth, async (req, res, next) => {
    try {
        const now = new Date();
        const audience = req.user ? (req.user.role === 'seller' ? ['all', 'sellers'] : ['all', 'buyers']) : ['all'];
        const rows = await prisma.announcement.findMany({
            where: { isActive: true, audience: { in: audience }, AND: [{ OR: [{ startsAt: null }, { startsAt: { lte: now } }] }, { OR: [{ endsAt: null }, { endsAt: { gt: now } }] }] },
            orderBy: { createdAt: 'desc' }, take: 3, select: { id: true, title: true, body: true, tone: true }
        });
        res.set('Cache-Control', 'public, max-age=60');
        res.json({ data: rows });
    } catch (err) { next(err); }
});

module.exports = { router, announcementsRouter };
