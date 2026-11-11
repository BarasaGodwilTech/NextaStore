'use strict';
/* The support desk: tickets, canned replies, follow-up tasks, Nexi handoffs and platform announcements. */
const express = require('express');
const prisma = require('../../prisma');
const config = require('../../config');
const { apiError } = require('../../utils');
const { sendMail } = require('../../mailer');
const { esc } = require('../../emailTemplates');
const { createNotification } = require('../../helpers');
const { validateBody, followUpSchema } = require('../../validation');
const A = require('../auth');
const { hasPermission, PERMISSIONS: PM } = require('../permissions');
const SUP = require('../support');
const TPL = require('../templates');

const router = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const can = (req, p) => hasPermission(req.staff, p);
const staffBrief = { select: { id: true, name: true } };
const personOf = (t) => ({ id: t.requester ? t.requester.id : null, name: t.requesterName || (t.requester && t.requester.name) || 'Customer', email: t.requesterEmail || (t.requester && t.requester.email) || '' });

const ticketRow = (t) => ({
    id: t.id, number: t.number, subject: t.subject, category: t.category, status: t.status, priority: t.priority,
    requester: personOf(t), assignee: t.assignee ? { id: t.assignee.id, name: t.assignee.name } : null,
    slaDueAt: t.slaDueAt, breached: SUP.isBreached(t), firstResponseAt: t.firstResponseAt, lastMessageAt: t.lastMessageAt, createdAt: t.createdAt, source: t.source,
    preview: t.messages && t.messages[0] ? String(t.messages[0].body).slice(0, 140) : undefined
});
const ticketInclude = { requester: { select: { id: true, name: true, email: true } }, assignee: staffBrief };

// ---- Tickets -----------------------------------------------------------------------------------------------------------------------------
router.get('/tickets/counts', A.requirePermission(PM.TICKETS_VIEW), wrap(async (req, res) => {
    const active = { status: { in: ['open', 'pending'] } };
    const [all, mine, unassigned, breached, urgent] = await Promise.all([
        prisma.supportTicket.count({ where: active }),
        prisma.supportTicket.count({ where: { ...active, assigneeId: req.staff.id } }),
        prisma.supportTicket.count({ where: { ...active, assigneeId: null } }),
        prisma.supportTicket.count({ where: { status: 'open', slaDueAt: { lt: new Date() } } }),
        prisma.supportTicket.count({ where: { ...active, priority: 'urgent' } })
    ]);
    res.json({ data: { active: all, mine, unassigned, breached, urgent } });
}));

router.get('/tickets', A.requirePermission(PM.TICKETS_VIEW), wrap(async (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1), pageSize = Math.min(100, Math.max(10, Number(req.query.pageSize) || 30));
    const q = String(req.query.q || '').trim().slice(0, 100);
    const where = {};
    if (req.query.status === 'active') where.status = { in: ['open', 'pending'] };
    else if (SUP.STATUSES.includes(req.query.status)) where.status = req.query.status;
    if (SUP.PRIORITIES.includes(req.query.priority)) where.priority = req.query.priority;
    if (req.query.assignee === 'me') where.assigneeId = req.staff.id;
    else if (req.query.assignee === 'unassigned') where.assigneeId = null;
    else if (req.query.assignee) where.assigneeId = String(req.query.assignee);
    if (req.query.breached === '1') { where.status = 'open'; where.slaDueAt = { lt: new Date() }; }
    if (SUP.CATEGORIES.includes(req.query.category)) where.category = req.query.category;
    if (q) where.OR = [{ subject: { contains: q, mode: 'insensitive' } }, { requesterEmail: { contains: q, mode: 'insensitive' } }, { requesterName: { contains: q, mode: 'insensitive' } }, ...(/^#?\d{1,9}$/.test(q) ? [{ number: Number(q.replace('#', '')) }] : [])];
    const [rows, total] = await Promise.all([
        prisma.supportTicket.findMany({ where, include: { ...ticketInclude, messages: { where: { isInternal: false }, orderBy: { createdAt: 'desc' }, take: 1 } }, orderBy: [{ status: 'asc' }, { priority: 'desc' }, { lastMessageAt: 'desc' }], skip: (page - 1) * pageSize, take: pageSize }),
        prisma.supportTicket.count({ where })
    ]);
    res.json({ data: { tickets: rows.map(ticketRow), page, pageSize, total, pages: Math.max(1, Math.ceil(total / pageSize)) } });
}));

router.post('/tickets', A.requirePermission(PM.TICKETS_MANAGE), wrap(async (req, res) => {
    const b = req.body || {};
    const subject = String(b.subject || '').trim(), body = String(b.body || '').trim();
    if (subject.length < 3 || subject.length > 160) throw apiError('Give the ticket a subject of 3 to 160 characters.', 400);
    if (body.length < 2 || body.length > 8000) throw apiError('Describe the issue.', 400);
    let requester = null;
    if (b.requesterId) { requester = await prisma.user.findUnique({ where: { id: String(b.requesterId) }, select: { id: true, name: true, email: true } }); if (!requester) throw apiError('That account was not found.', 404); }
    const email = requester ? requester.email : String(b.requesterEmail || '').trim().toLowerCase();
    if (!requester && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw apiError('Choose an account or enter the customer\'s email.', 400);
    const priority = SUP.PRIORITIES.includes(b.priority) ? b.priority : 'normal';
    const t = await prisma.supportTicket.create({ data: {
        subject, category: SUP.CATEGORIES.includes(b.category) ? b.category : 'general', priority, requesterId: requester ? requester.id : null,
        requesterName: requester ? requester.name : String(b.requesterName || '').trim().slice(0, 80), requesterEmail: email, source: 'staff',
        assigneeId: b.assignToMe ? req.staff.id : null, relatedOrderId: b.relatedOrderId ? String(b.relatedOrderId).slice(0, 40) : null, slaDueAt: SUP.slaDueFrom(priority),
        messages: { create: { authorKind: 'customer', authorName: requester ? requester.name : 'Customer', body, authorStaffId: null } }
    }, include: ticketInclude });
    await A.audit(req, 'ticket.created', 'ticket', t.id, { targetUserId: requester ? requester.id : null, metadata: { number: t.number } });
    res.status(201).json({ data: ticketRow(t) });
}));

router.get('/tickets/:id', A.requirePermission(PM.TICKETS_VIEW), wrap(async (req, res) => {
    const t = await prisma.supportTicket.findUnique({ where: { id: req.params.id }, include: { ...ticketInclude, messages: { orderBy: { createdAt: 'asc' }, include: { authorStaff: staffBrief } } } });
    if (!t) throw apiError('Ticket not found.', 404, 'NOT_FOUND');
    let customer = null;
    if (t.requester && can(req, PM.USERS_VIEW)) {
        const u = await prisma.user.findUnique({ where: { id: t.requester.id }, include: { store: { select: { id: true, name: true, slug: true } } } });
        const orders = can(req, PM.ORDERS_VIEW) ? await prisma.order.findMany({ where: { OR: [{ buyerId: u.id }, ...(u.store ? [{ storeId: u.store.id }] : [])], deletedAt: null }, orderBy: { createdAt: 'desc' }, take: 5, select: { id: true, status: true, total: true, createdAt: true } }) : null;
        const earlier = await prisma.supportTicket.count({ where: { requesterId: u.id } });
        customer = { id: u.id, name: u.name, email: u.email, role: u.role, accountStatus: u.accountStatus, createdAt: u.createdAt, emailVerified: !!u.emailVerifiedAt, store: u.store, tickets: earlier, orders: orders && orders.map((o) => ({ ...o, total: Number(o.total) })) };
    }
    res.json({ data: { ticket: ticketRow(t), relatedOrderId: t.relatedOrderId, resolvedAt: t.resolvedAt, customer,
        messages: t.messages.map((m) => ({ id: m.id, kind: m.authorKind, author: m.authorStaff ? m.authorStaff.name : (m.authorName || (m.authorKind === 'customer' ? 'Customer' : 'System')), body: m.body, internal: m.isInternal, at: m.createdAt })) } });
}));

router.post('/tickets/:id/messages', A.requirePermission(PM.TICKETS_MANAGE), wrap(async (req, res) => {
    const body = String((req.body && req.body.body) || '').trim();
    if (body.length < 1 || body.length > 8000) throw apiError('Write a message of up to 8000 characters.', 400);
    const internal = !!(req.body && req.body.internal);
    const t = await prisma.supportTicket.findUnique({ where: { id: req.params.id }, include: ticketInclude });
    if (!t) throw apiError('Ticket not found.', 404, 'NOT_FOUND');
    if (t.status === 'closed' && !internal) throw apiError('This ticket is closed. Reopen it to reply.', 409);
    const now = new Date();
    const msg = await prisma.supportTicketMessage.create({ data: { ticketId: t.id, authorKind: 'staff', authorStaffId: req.staff.id, authorName: req.staff.name, body, isInternal: internal } });
    const data = { lastMessageAt: now };
    if (!internal) {
        // A public reply answers the customer: the response clock stops, the ticket now waits on them, and the sender takes it if nobody had it.
        data.slaDueAt = null; data.status = req.body.keepOpen ? t.status : 'pending';
        if (!t.firstResponseAt) data.firstResponseAt = now;
        if (!t.assigneeId) data.assigneeId = req.staff.id;
    }
    await prisma.supportTicket.update({ where: { id: t.id }, data });
    if (!internal) {
        const p = personOf(t);
        if (p.email) {
            const text = `Hi ${p.name.split(/\s+/)[0] || 'there'},\n\n${body}\n\n— ${req.staff.name}, NextaStore Support\nTicket #${t.number}: ${t.subject}\n\nYou can reply from your NextaStore account's Help page.`;
            try { await sendMail({ to: p.email, subject: `Re: [#${t.number}] ${t.subject}`, text, html: `<div style="font-family:Segoe UI,Roboto,Arial,sans-serif;font-size:15px;line-height:1.55;color:#24352d"><p>Hi ${esc(p.name.split(/\s+/)[0] || 'there')},</p><p style="white-space:pre-wrap">${esc(body)}</p><p>— ${esc(req.staff.name)}, NextaStore Support<br><span style="color:#6b7c73;font-size:12px">Ticket #${t.number}: ${esc(t.subject)}</span></p></div>` }); }
            catch (err) { console.warn('[staff] ticket reply email failed:', err.message); }
        }
        if (p.id) await createNotification({ userId: p.id, type: 'subscription', title: `Support replied to #${t.number}`, body: body.slice(0, 140), link: '/support' });
    }
    await A.audit(req, internal ? 'ticket.note_added' : 'ticket.replied', 'ticket', t.id, { targetUserId: t.requester ? t.requester.id : null, metadata: { number: t.number } });
    res.status(201).json({ data: { id: msg.id } });
}));

router.put('/tickets/:id', A.requirePermission(PM.TICKETS_MANAGE), wrap(async (req, res) => {
    const t = await prisma.supportTicket.findUnique({ where: { id: req.params.id } });
    if (!t) throw apiError('Ticket not found.', 404, 'NOT_FOUND');
    const b = req.body || {}; const data = {}; const changes = {};
    if (b.status !== undefined && b.status !== t.status) {
        if (!SUP.STATUSES.includes(b.status)) throw apiError('Unknown status.', 400);
        data.status = b.status; changes.status = [t.status, b.status];
        if (b.status === 'resolved' || b.status === 'closed') { data.resolvedAt = t.resolvedAt || new Date(); data.slaDueAt = null; }
        else { data.resolvedAt = null; if (!t.firstResponseAt || b.status === 'open') data.slaDueAt = SUP.slaDueFrom(b.priority || t.priority); }
    }
    if (b.priority !== undefined && b.priority !== t.priority) {
        if (!SUP.PRIORITIES.includes(b.priority)) throw apiError('Unknown priority.', 400);
        data.priority = b.priority; changes.priority = [t.priority, b.priority];
        if (t.slaDueAt && !data.slaDueAt && ['open', 'pending'].includes(data.status || t.status)) data.slaDueAt = SUP.slaDueFrom(b.priority, t.createdAt);
    }
    if (b.category !== undefined && b.category !== t.category) { if (!SUP.CATEGORIES.includes(b.category)) throw apiError('Unknown category.', 400); data.category = b.category; }
    if (b.assigneeId !== undefined && (b.assigneeId || null) !== t.assigneeId) {
        if (b.assigneeId) {
            const a = await prisma.staffAccount.findUnique({ where: { id: String(b.assigneeId) }, include: { role: true } });
            if (!a || a.status !== 'active' || !hasPermission(a, PM.TICKETS_VIEW)) throw apiError('That person cannot work support tickets.', 400);
        }
        data.assigneeId = b.assigneeId || null; changes.assignee = [t.assigneeId, data.assigneeId];
    }
    if (!Object.keys(data).length) throw apiError('Nothing to change.', 400);
    const updated = await prisma.supportTicket.update({ where: { id: t.id }, data, include: ticketInclude });
    if (Object.keys(changes).length) await prisma.supportTicketMessage.create({ data: { ticketId: t.id, authorKind: 'system', authorName: 'System', body: `${req.staff.name} changed ${Object.entries(changes).map(([k, [a, c]]) => `${k}${k === 'assignee' ? '' : `: ${a} → ${c}`}`).join(', ')}`, isInternal: true } });
    await A.audit(req, 'ticket.updated', 'ticket', t.id, { targetUserId: t.requesterId, metadata: { number: t.number, ...changes } });
    res.json({ data: ticketRow(updated) });
}));

// ---- Canned replies ------------------------------------------------------------------------------------------------------------------------
router.get('/canned-replies', A.requireAnyPermission(PM.TICKETS_VIEW, PM.USERS_CONTACT, PM.BROADCASTS_SEND, PM.CANNED_MANAGE), wrap(async (req, res) => {
    const kind = TPL.KINDS.includes(req.query.kind) ? req.query.kind : undefined;
    res.json({ data: { templates: await prisma.cannedReply.findMany({ where: kind ? { kind } : {}, orderBy: [{ kind: 'asc' }, { category: 'asc' }, { title: 'asc' }], take: 300 }), variables: TPL.VARIABLES.map(([key, label, example]) => ({ key, label, example })) } });
}));
function cannedBody(req) {
    const title = String(req.body.title || '').trim(), body = String(req.body.body || '').trim();
    if (title.length < 2 || title.length > 80) throw apiError('Give the reply a title of 2 to 80 characters.', 400);
    if (body.length < 2 || body.length > 4000) throw apiError('Write the reply text.', 400);
    const kind = TPL.KINDS.includes(req.body.kind) ? req.body.kind : 'reply';
    const subject = String(req.body.subject || '').trim().slice(0, 150);
    if (kind === 'email' && subject.length < 3) throw apiError('Email templates need a subject line.', 400);
    return { title, body, kind, subject, category: String(req.body.category || '').trim().toLowerCase().replace(/[^a-z0-9 _-]/g, '').slice(0, 30) || 'general' };
}
router.post('/canned-replies', A.requirePermission(PM.CANNED_MANAGE), wrap(async (req, res) => { const r = await prisma.cannedReply.create({ data: { ...cannedBody(req), createdById: req.staff.id } }); await A.audit(req, 'canned_reply.created', 'canned_reply', r.id); res.status(201).json({ data: r }); }));
router.put('/canned-replies/:id', A.requirePermission(PM.CANNED_MANAGE), wrap(async (req, res) => { if (!(await prisma.cannedReply.findUnique({ where: { id: req.params.id } }))) throw apiError('Reply not found.', 404); const r = await prisma.cannedReply.update({ where: { id: req.params.id }, data: cannedBody(req) }); await A.audit(req, 'canned_reply.updated', 'canned_reply', r.id); res.json({ data: r }); }));
router.delete('/canned-replies/:id', A.requirePermission(PM.CANNED_MANAGE), wrap(async (req, res) => { if (!(await prisma.cannedReply.findUnique({ where: { id: req.params.id } }))) throw apiError('Reply not found.', 404); await prisma.cannedReply.delete({ where: { id: req.params.id } }); await A.audit(req, 'canned_reply.deleted', 'canned_reply', req.params.id); res.json({ data: { ok: true } }); }));

// ---- Follow-ups (internal tasks) -----------------------------------------------------------------------------------------------------------
const fuInclude = { relatedUser: { select: { id: true, name: true, email: true } }, assignedTo: staffBrief, adminRole: { select: { id: true, name: true } } };
async function checkAssignee(id) {
    if (!id) return;
    const a = await prisma.staffAccount.findUnique({ where: { id } });
    if (!a || a.status !== 'active') throw apiError('Follow-ups can only be assigned to active staff.', 400);
}
router.get('/follow-ups', A.requirePermission(PM.FOLLOWUPS_MANAGE), wrap(async (req, res) => {
    const status = ['open', 'in_progress', 'done', 'cancelled'].includes(req.query.status) ? req.query.status : undefined;
    const mine = req.query.assignee === 'me';
    res.json({ data: await prisma.adminFollowUp.findMany({ where: { ...(status ? { status } : {}), ...(mine ? { assignedToId: req.staff.id } : {}) }, include: fuInclude, orderBy: [{ status: 'asc' }, { dueAt: 'asc' }, { createdAt: 'desc' }], take: 200 }) });
}));
router.post('/follow-ups', A.requirePermission(PM.FOLLOWUPS_MANAGE), validateBody(followUpSchema), wrap(async (req, res) => {
    const p = req.body; await checkAssignee(p.assignedToId);
    const row = await prisma.adminFollowUp.create({ data: { title: p.title, note: p.note || '', status: p.status || 'open', dueAt: p.dueAt ? new Date(p.dueAt) : null, relatedUserId: p.relatedUserId || null, assignedToId: p.assignedToId || null, adminRoleId: p.adminRoleId || null }, include: fuInclude });
    await A.audit(req, 'follow_up.created', 'follow_up', row.id, { targetUserId: row.relatedUserId, metadata: { title: row.title } });
    res.status(201).json({ data: row });
}));
router.put('/follow-ups/:id', A.requirePermission(PM.FOLLOWUPS_MANAGE), validateBody(followUpSchema), wrap(async (req, res) => {
    const p = req.body; const current = await prisma.adminFollowUp.findUnique({ where: { id: req.params.id } });
    if (!current) throw apiError('Follow-up not found.', 404);
    const data = {};
    for (const k of ['title', 'note', 'status', 'relatedUserId', 'assignedToId', 'adminRoleId']) if (p[k] !== undefined) data[k] = p[k] || null;
    if (p.dueAt !== undefined) data.dueAt = p.dueAt ? new Date(p.dueAt) : null;
    if (p.status === 'done') data.completedAt = new Date(); else if (p.status) data.completedAt = null;
    await checkAssignee(data.assignedToId);
    const row = await prisma.adminFollowUp.update({ where: { id: current.id }, data, include: fuInclude });
    await A.audit(req, 'follow_up.updated', 'follow_up', row.id, { targetUserId: row.relatedUserId, metadata: { fields: Object.keys(data) } });
    res.json({ data: row });
}));

// ---- Nexi handoffs -------------------------------------------------------------------------------------------------------------------------
router.get('/nexi-handoffs', A.requirePermission(PM.NEXI_VIEW), (req, res) => require('../../assistantProxy').handoffs(req, res));

// ---- Announcements -------------------------------------------------------------------------------------------------------------------------
function annBody(req) {
    const title = String(req.body.title || '').trim(), body = String(req.body.body || '').trim();
    if (title.length < 3 || title.length > 120) throw apiError('Give the announcement a title of 3 to 120 characters.', 400);
    if (body.length > 500) throw apiError('Keep the message under 500 characters.', 400);
    const d = (v) => (v ? new Date(v) : null);
    const startsAt = d(req.body.startsAt), endsAt = d(req.body.endsAt);
    if ((startsAt && Number.isNaN(startsAt.getTime())) || (endsAt && Number.isNaN(endsAt.getTime()))) throw apiError('Check the dates.', 400);
    if (startsAt && endsAt && endsAt <= startsAt) throw apiError('The end must be after the start.', 400);
    return { title, body, tone: ['info', 'warning', 'success'].includes(req.body.tone) ? req.body.tone : 'info', audience: ['all', 'sellers', 'buyers'].includes(req.body.audience) ? req.body.audience : 'all', isActive: !!req.body.isActive, startsAt, endsAt };
}
router.get('/announcements', A.requirePermission(PM.ANNOUNCEMENTS_MANAGE), wrap(async (req, res) => res.json({ data: await prisma.announcement.findMany({ orderBy: { createdAt: 'desc' }, take: 100 }) })));
router.post('/announcements', A.requirePermission(PM.ANNOUNCEMENTS_MANAGE), wrap(async (req, res) => { const a = await prisma.announcement.create({ data: { ...annBody(req), createdById: req.staff.id } }); await A.audit(req, 'announcement.created', 'announcement', a.id, { metadata: { title: a.title, active: a.isActive } }); res.status(201).json({ data: a }); }));
router.put('/announcements/:id', A.requirePermission(PM.ANNOUNCEMENTS_MANAGE), wrap(async (req, res) => { if (!(await prisma.announcement.findUnique({ where: { id: req.params.id } }))) throw apiError('Announcement not found.', 404); const a = await prisma.announcement.update({ where: { id: req.params.id }, data: annBody(req) }); await A.audit(req, 'announcement.updated', 'announcement', a.id, { metadata: { title: a.title, active: a.isActive } }); res.json({ data: a }); }));
router.delete('/announcements/:id', A.requirePermission(PM.ANNOUNCEMENTS_MANAGE), wrap(async (req, res) => { if (!(await prisma.announcement.findUnique({ where: { id: req.params.id } }))) throw apiError('Announcement not found.', 404); await prisma.announcement.delete({ where: { id: req.params.id } }); await A.audit(req, 'announcement.deleted', 'announcement', req.params.id); res.json({ data: { ok: true } }); }));

module.exports = router;
