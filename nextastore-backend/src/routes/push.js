const express = require('express');
const prisma = require('../prisma');
const config = require('../config');
const { apiError } = require('../utils');
const { sendPushToUser } = require('../push');
const { requireAuth } = require('../middleware');
const { validateBody, pushSubscribeSchema, pushUnsubscribeSchema } = require('../validation');

const router = express.Router();

// Unauthenticated on purpose: this is a public key, not a secret (that's
// the whole point of VAPID's asymmetric keypair — see config.js). The
// frontend needs it before the person has necessarily done anything, and
// checks `enabled` before ever showing the "turn on notifications" prompt
// or calling pushManager.subscribe(), so a deployment with no keys
// configured yet never asks a browser for permission it can't use.
router.get('/public-key', (req, res) => {
    res.json({ data: { enabled: config.pushEnabled, publicKey: config.pushEnabled ? config.vapid.publicKey : null } });
});

// Called once the browser has actually created a subscription (see
// js/push.js). Upserts on `endpoint` — the same device re-subscribing
// (e.g. after the service worker updated) just refreshes its keys/owner
// rather than creating a duplicate row, and a subscription that used to
// belong to a different account on a shared browser is quietly
// re-attributed to whoever is logged in now.
router.post('/subscribe', requireAuth, validateBody(pushSubscribeSchema), async (req, res, next) => {
    try {
        const { endpoint, keys, userAgent } = req.body;
        const saved = await prisma.pushSubscription.upsert({
            where: { endpoint },
            update: { userId: req.user.id, p256dh: keys.p256dh, auth: keys.auth, userAgent: userAgent || '' },
            create: { userId: req.user.id, endpoint, p256dh: keys.p256dh, auth: keys.auth, userAgent: userAgent || '' }
        });
        res.status(201).json({ data: { id: saved.id } });
    } catch (err) { next(err); }
});

// Called when the person turns notifications off from Settings, or when
// the service worker reports its subscription was invalidated. Deleting by
// endpoint (not id) means this also works as "forget this device" from a
// page that only ever had the browser's own PushSubscription object, never
// our row's id. Not scoped to req.user.id: the subscription is dead either
// way and any signed-in caller removing it is a strictly safe no-op if it
// happened to belong to someone else (e.g. a shared browser).
router.post('/unsubscribe', requireAuth, validateBody(pushUnsubscribeSchema), async (req, res, next) => {
    try {
        await prisma.pushSubscription.deleteMany({ where: { endpoint: req.body.endpoint } });
        res.json({ data: { ok: true } });
    } catch (err) { next(err); }
});

// A lightweight "is push actually turned on for this device" check the
// settings page can use to reflect real state instead of just the last
// browser Notification.permission value, which can drift (e.g. permission
// granted but the subscribe call never completed).
router.get('/status', requireAuth, async (req, res, next) => {
    try {
        const count = await prisma.pushSubscription.count({ where: { userId: req.user.id } });
        res.json({ data: { enabled: config.pushEnabled, subscribedDevices: count } });
    } catch (err) { next(err); }
});

// The Settings \"Send a test\" button. Sends only to the caller's own devices
// (sendPushToUser is keyed by req.user.id, never by anything in the request)
// and is throttled per person so it can't be used to spam a phone, which is
// also why it reports 429 instead of quietly dropping the second tap. The map
// is per server process: fine for one instance, and with several the limit is
// simply per instance, which still bounds the abuse.
const TEST_COOLDOWN_MS = 30 * 1000;
const lastTestAt = new Map();

function testCooldownLeftMs(userId, now = Date.now()) {
    const last = lastTestAt.get(userId);
    return last ? Math.max(0, last + TEST_COOLDOWN_MS - now) : 0;
}

router.post('/test', requireAuth, async (req, res, next) => {
    try {
        if (!config.pushEnabled) throw apiError('Push notifications are not set up on this server yet.', 503);

        const now = Date.now();
        const left = testCooldownLeftMs(req.user.id, now);
        if (left > 0) {
            res.set('Retry-After', String(Math.ceil(left / 1000)));
            throw apiError('Please wait a moment before sending another test.', 429);
        }
        // Forget people whose cooldown has long passed so the map can't grow
        // without bound on a long-running process.
        if (lastTestAt.size > 1000) {
            for (const [id, at] of lastTestAt) if (now - at > TEST_COOLDOWN_MS) lastTestAt.delete(id);
        }

        const result = await sendPushToUser(req.user.id, {
            type: 'test',
            title: 'Notifications are on',
            body: 'This is a test from NextaStore. You will get order and message alerts like this one.',
            link: '/'
        });
        if (!result.devices) throw apiError('No device is registered for notifications yet. Turn notifications on first.', 409);

        // Only a send that actually went out starts the cooldown, so a
        // failed attempt can be retried straight away.
        if (result.sent) lastTestAt.set(req.user.id, now);
        res.json({ data: { devices: result.devices, sent: result.sent, failed: result.failed, removed: result.removed } });
    } catch (err) { next(err); }
});

module.exports = router;
