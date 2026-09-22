const express = require('express');
const prisma = require('../prisma');
const { apiError } = require('../utils');
const { requireAuth } = require('../middleware');

const router = express.Router();

// The exterior bell-badge count. This is deliberately NOT the same thing as
// "how many notifications are unread" (that's `readAt`, see below) — it
// reflects `acknowledgedAt`, which only clears in bulk when the bell
// dropdown itself is opened (PUT /acknowledge). A person can have 10 unread
// items sitting in the list with a badge of 0, because they've already
// opened the bell once and just haven't tapped into each item yet.
router.get('/unread-count', requireAuth, async (req, res, next) => {
    try {
        const count = await prisma.notification.count({ where: { userId: req.user.id, acknowledgedAt: null } });
        res.json({ data: { count } });
    } catch (err) {
        next(err);
    }
});

// Most-recent 30, newest first, plus both counts — enough for a bell
// dropdown without paginating something this small. `unreadCount` is the
// item-level count (readAt-based); `bellCount` is the exterior-badge count
// (acknowledgedAt-based) — see the comment on GET /unread-count.
//
// `?unread=1` is the dropdown's "Unread" filter: the most recent 30 that are
// still UNREAD. It has to be done here rather than by filtering the plain
// list in the browser — with more than 30 notifications an unread one older
// than the newest 30 would otherwise be unreachable, which is exactly the
// case the filter exists for. The counts are the same either way (they are
// totals, not a count of what was returned).
router.get('/', requireAuth, async (req, res, next) => {
    try {
        const unreadOnly = req.query.unread === '1';
        const [notifications, unreadCount, bellCount] = await Promise.all([
            prisma.notification.findMany({
                where: { userId: req.user.id, ...(unreadOnly ? { readAt: null } : {}) },
                orderBy: { createdAt: 'desc' },
                take: 30
            }),
            prisma.notification.count({ where: { userId: req.user.id, readAt: null } }),
            prisma.notification.count({ where: { userId: req.user.id, acknowledgedAt: null } })
        ]);
        res.json({ data: notifications, unreadCount, bellCount });
    } catch (err) {
        next(err);
    }
});

// Opening the bell dropdown calls this. It only stamps `acknowledgedAt` —
// each item's own `readAt` (and its unread highlight in the list) is
// untouched until that specific notification is tapped.
router.put('/acknowledge', requireAuth, async (req, res, next) => {
    try {
        await prisma.notification.updateMany({
            where: { userId: req.user.id, acknowledgedAt: null },
            data: { acknowledgedAt: new Date() }
        });
        res.json({ data: { ok: true } });
    } catch (err) {
        next(err);
    }
});

router.put('/:id/read', requireAuth, async (req, res, next) => {
    try {
        const notification = await prisma.notification.findFirst({ where: { id: req.params.id, userId: req.user.id } });
        if (!notification) throw apiError('Notification not found.', 404);
        // Reading an item necessarily means it's been seen, so this also
        // settles acknowledgement if it hadn't happened yet (e.g. the
        // person tapped a toast/link without ever opening the bell) —
        // otherwise the exterior badge would stay stuck counting a
        // notification the person has now read in full.
        const updated = await prisma.notification.update({
            where: { id: notification.id },
            data: { readAt: new Date(), acknowledgedAt: notification.acknowledgedAt || new Date() }
        });
        res.json({ data: updated });
    } catch (err) {
        next(err);
    }
});

// The explicit "Mark all as read" batch action inside the tray. Distinct
// from PUT /acknowledge: this clears every item's own unread state (not
// just the bell badge).
router.put('/read-all', requireAuth, async (req, res, next) => {
    try {
        const now = new Date();
        await prisma.notification.updateMany({
            where: { userId: req.user.id, readAt: null },
            data: { readAt: now, acknowledgedAt: now }
        });
        res.json({ data: { ok: true } });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
