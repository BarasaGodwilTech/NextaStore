'use strict';
/*
 * Reaching people: one-to-one messages, broadcasts to a group, and the console-wide search.
 *
 *   POST /users/:id/contact        users.contact      email and/or in-app message to one account (logged as a note + audit entry)
 *   POST /broadcasts/preview       broadcasts.send    how many people an audience contains, before anything is sent
 *   POST /broadcasts               broadcasts.send    send it (PIN step-up, count must match the preview, one at a time)
 *   GET  /broadcasts               broadcasts.send    history / receipts
 *   GET  /search?q=                any                people, stores, orders, tickets, staff: only what the caller may see
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const prisma = require('../../prisma');
const config = require('../../config');
const { apiError } = require('../../utils');
const { sendMail } = require('../../mailer');
const { esc } = require('../../emailTemplates');
const { createNotification } = require('../../helpers');
const A = require('../auth');
const T = require('../templates');
const { hasPermission, PERMISSIONS: PM } = require('../permissions');

const router = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const MAX_EMAIL_RECIPIENTS = 5000;

const contactLimiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: Number(process.env.STAFF_CONTACT_LIMIT) || 30, standardHeaders: true, legacyHeaders: false,
    keyGenerator: (req) => (req.staff ? req.staff.id : req.ip), message: { message: 'You are sending messages very quickly. Wait a few minutes and try again.', code: 'RATE_LIMITED' } });

/** The plain text the staff member wrote, as a branded email. Links are not auto-created: staff write addresses out in full. */
function emailHtml(subject, text) {
    const paras = String(text).split(/\n{2,}/).map((p) => `<p style="margin:0 0 14px;font-size:16px;line-height:1.55;color:#24352d">${esc(p).replace(/\n/g, '<br>')}</p>`).join('');
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(subject)}</title></head><body style="margin:0;background:#f2f6f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:28px 14px"><table role="presentation" width="100%" style="max-width:520px;background:#fff;border-radius:18px;overflow:hidden;border:1px solid #dfe9e3"><tr><td style="background:#0b3b2b;padding:20px 28px;color:#fff;font-size:20px;font-weight:800">NextaStore</td></tr><tr><td style="padding:28px">${paras}</td></tr><tr><td style="padding:14px 28px;background:#f7faf8;font-size:12px;color:#6b7c73">You are receiving this because you have a NextaStore account.</td></tr></table></td></tr></table></body></html>`;
}
async function deliverEmail(to, subject, text) {
    const r = await sendMail({ to, subject, text, html: emailHtml(subject, text) });
    return r.delivered !== false;
}

// ---- one person ------------------------------------------------------------------------------------------------------------------------
router.post('/users/:id/contact', A.requirePermission(PM.USERS_CONTACT), contactLimiter, wrap(async (req, res) => {
    const user = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!user) throw apiError('Account not found.', 404);
    const channels = Array.from(new Set((Array.isArray(req.body.channels) ? req.body.channels : []).filter((c) => c === 'email' || c === 'in_app')));
    if (!channels.length) throw apiError('Choose how to reach them: email, in-app notification, or both.', 400);
    const subject = str(req.body.subject, 150), body = str(req.body.body, 4000);
    if (body.length < 5) throw apiError('Write the message (at least a few words).', 400);
    if (channels.includes('email') && subject.length < 3) throw apiError('Emails need a subject line.', 400);
    const vars = T.varsFor(user, req.staff);
    const finalSubject = T.render(subject, vars), finalBody = T.render(body, vars);
    const result = { email: null, inApp: null };
    if (channels.includes('email')) {
        if (!user.emailVerifiedAt && !req.body.allowUnverified) result.email = 'skipped_unverified';
        else { try { result.email = (await deliverEmail(user.email, finalSubject, finalBody)) ? 'sent' : 'not_configured'; } catch (e) { console.warn('[staff] contact email failed:', e.message); result.email = 'failed'; } }
    }
    if (channels.includes('in_app')) {
        await createNotification({ userId: user.id, type: 'staff_message', title: finalSubject || 'A message from NextaStore', body: finalBody.slice(0, 500), link: '/notifications' });
        result.inApp = 'sent';
    }
    await prisma.userNote.create({ data: { userId: user.id, authorId: req.staff.id, authorName: req.staff.name, body: `Messaged by ${channels.join(' + ').replace('in_app', 'in-app')}${finalSubject ? `: "${finalSubject}"` : ''}` } });
    await A.audit(req, 'user.contacted', 'user', user.id, { targetUserId: user.id, metadata: { channels, subject: finalSubject, result } });
    res.json({ data: result });
}));

// ---- groups ----------------------------------------------------------------------------------------------------------------------------
const AUDIENCES = { all: 'Everyone', sellers: 'All sellers', buyers: 'All shoppers', new_7d: 'People who joined in the last 7 days' };
function audienceWhere(audience) {
    const base = { accountStatus: 'active' };
    if (audience === 'sellers') return { ...base, role: 'seller' };
    if (audience === 'buyers') return { ...base, role: 'buyer' };
    if (audience === 'new_7d') return { ...base, createdAt: { gt: new Date(Date.now() - 7 * 86400000) } };
    return base;
}
const audienceOf = (v) => { if (!AUDIENCES[v]) throw apiError('Choose who should receive it.', 400); return v; };

router.get('/broadcasts/audiences', A.requirePermission(PM.BROADCASTS_SEND), wrap(async (req, res) => {
    res.json({ data: await Promise.all(Object.entries(AUDIENCES).map(async ([key, label]) => ({ key, label, count: await prisma.user.count({ where: audienceWhere(key) }) }))) });
}));

router.post('/broadcasts/preview', A.requirePermission(PM.BROADCASTS_SEND), wrap(async (req, res) => {
    const where = audienceWhere(audienceOf(req.body.audience));
    const [total, emailable, sample] = await Promise.all([
        prisma.user.count({ where }), prisma.user.count({ where: { ...where, emailVerifiedAt: { not: null } } }),
        prisma.user.findMany({ where, select: { name: true }, orderBy: { createdAt: 'desc' }, take: 3 })
    ]);
    res.json({ data: { audience: req.body.audience, label: AUDIENCES[req.body.audience], total, emailable, sample: sample.map((u) => u.name), emailCap: MAX_EMAIL_RECIPIENTS } });
}));

router.post('/broadcasts', A.requirePermission(PM.BROADCASTS_SEND), A.requireRecentAuth, wrap(async (req, res) => {
    const audience = audienceOf(req.body.audience);
    const channels = Array.from(new Set((Array.isArray(req.body.channels) ? req.body.channels : []).filter((c) => c === 'email' || c === 'in_app')));
    if (!channels.length) throw apiError('Choose at least one way to send it.', 400);
    const title = str(req.body.title, 100) || str(req.body.subject, 100), subject = str(req.body.subject, 150), body = str(req.body.body, 4000);
    if (title.length < 3) throw apiError('Give the broadcast a name so you can find it later.', 400);
    if (body.length < 10) throw apiError('Write the message.', 400);
    if (channels.includes('email') && subject.length < 3) throw apiError('Emails need a subject line.', 400);
    const where = audienceWhere(audience);
    const total = await prisma.user.count({ where });
    if (!total) throw apiError('Nobody is in that group right now.', 409);
    if (Number(req.body.confirmCount) !== total) throw apiError(`The group changed (it now has ${total} people). Review the preview again before sending.`, 409, 'BROADCAST_COUNT_CHANGED');
    if (channels.includes('email') && total > MAX_EMAIL_RECIPIENTS) throw apiError(`Emails are limited to ${MAX_EMAIL_RECIPIENTS} people per broadcast. Use a smaller group, or send in-app only.`, 400);
    const busy = await prisma.broadcast.findFirst({ where: { status: 'sending', createdAt: { gt: new Date(Date.now() - 15 * 60000) } } });
    if (busy) throw apiError('Another broadcast is still being sent. Wait for it to finish.', 409, 'BROADCAST_BUSY');
    const row = await prisma.broadcast.create({ data: { title, subject, body, audience, channels, recipients: total, sentById: req.staff.id, sentByLabel: `${req.staff.name} <${req.staff.email}>` } });
    await A.audit(req, 'broadcast.sent', 'broadcast', row.id, { metadata: { title, audience, channels, recipients: total } });
    res.status(202).json({ data: row });
    // Delivery continues after the response, in pages, so a large group never ties up the request.
    setImmediate(() => deliverBroadcast(row, where, channels).catch((e) => console.error('[staff] broadcast failed:', e)));
}));

async function deliverBroadcast(row, where, channels) {
    let cursor = null, inApp = 0, ok = 0, bad = 0;
    for (;;) {
        const users = await prisma.user.findMany({ where, orderBy: { id: 'asc' }, take: 200, ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}), select: { id: true, name: true, email: true, emailVerifiedAt: true } });
        if (!users.length) break;
        cursor = users[users.length - 1].id;
        for (const u of users) {
            const vars = T.varsFor(u, { name: 'NextaStore' });
            if (channels.includes('in_app')) { await createNotification({ userId: u.id, type: 'staff_message', title: T.render(row.subject || row.title, vars), body: T.render(row.body, vars).slice(0, 500), link: '/notifications' }); inApp += 1; }
            if (channels.includes('email') && u.emailVerifiedAt) { try { (await deliverEmail(u.email, T.render(row.subject, vars), T.render(row.body, vars))) ? ok += 1 : bad += 1; } catch (e) { bad += 1; } }
        }
        await prisma.broadcast.update({ where: { id: row.id }, data: { inAppSent: inApp, emailSent: ok, emailFailed: bad } });
    }
    await prisma.broadcast.update({ where: { id: row.id }, data: { status: 'sent', finishedAt: new Date(), inAppSent: inApp, emailSent: ok, emailFailed: bad } });
}

router.get('/broadcasts', A.requirePermission(PM.BROADCASTS_SEND), wrap(async (req, res) => res.json({ data: await prisma.broadcast.findMany({ orderBy: { createdAt: 'desc' }, take: 50 }) })));

// ---- search ----------------------------------------------------------------------------------------------------------------------------
router.get('/search', wrap(async (req, res) => {
    const q = str(req.query.q, 80);
    if (q.length < 2) return res.json({ data: { results: [] } });
    const has = (p) => hasPermission(req.staff, p);
    const ci = { contains: q, mode: 'insensitive' };
    const jobs = [];
    if (has(PM.USERS_VIEW)) jobs.push(prisma.user.findMany({ where: { OR: [{ name: ci }, { email: ci }, { id: { equals: q } }] }, select: { id: true, name: true, email: true, role: true }, take: 5 }).then((rows) => rows.map((u) => ({ type: 'person', id: u.id, title: u.name, sub: `${u.email} · ${u.role === 'seller' ? 'Seller' : 'Shopper'}`, go: `users/${u.id}` }))));
    if (has(PM.STORES_VIEW)) jobs.push(prisma.store.findMany({ where: { OR: [{ name: ci }, { slug: ci }] }, select: { id: true, name: true, slug: true }, take: 5 }).then((rows) => rows.map((s) => ({ type: 'store', id: s.id, title: s.name, sub: `Store · ${s.slug}`, go: "stores" }))));
    if (has(PM.ORDERS_VIEW)) jobs.push(prisma.order.findMany({ where: { OR: [{ id: { startsWith: q.toUpperCase() } }, { customerName: ci }] }, select: { id: true, customerName: true, status: true }, take: 5 }).then((rows) => rows.map((o) => ({ type: 'order', id: o.id, title: `Order ${o.id}`, sub: `${o.customerName} · ${o.status}`, go: `orders/${o.id}` }))));
    if (has(PM.TICKETS_VIEW)) { const n = Number(q.replace(/^#/, '')); jobs.push(prisma.supportTicket.findMany({ where: { OR: [{ subject: ci }, ...(Number.isInteger(n) && n > 0 ? [{ number: n }] : [])] }, select: { id: true, number: true, subject: true, status: true }, take: 5 }).then((rows) => rows.map((t) => ({ type: 'ticket', id: t.id, title: `#${t.number} ${t.subject}`, sub: `Ticket · ${t.status}`, go: `tickets/${t.id}` })))); }
    if (has(PM.STAFF_VIEW)) jobs.push(prisma.staffAccount.findMany({ where: { OR: [{ name: ci }, { email: ci }] }, select: { id: true, name: true, email: true }, take: 4 }).then((rows) => rows.map((s) => ({ type: 'staff', id: s.id, title: s.name, sub: `Staff · ${s.email}`, go: "staff" }))));
    const settled = await Promise.allSettled(jobs);
    res.json({ data: { results: settled.filter((r) => r.status === 'fulfilled').flatMap((r) => r.value) } });
}));

module.exports = router;
module.exports.AUDIENCES = AUDIENCES;
