/**
 * Web Push sending. This is the server-side half of item 3 (mobile push
 * notifications) -- the browser-side half is service-worker.js (the push
 * listener) and js/push.js (permission UI + subscribing).
 *
 * Deliberately mirrors the never-throws contract of
 * helpers.js#createNotification: sending a push is a best-effort side
 * effect of something that already succeeded (an order was placed, a
 * message was sent), so a push failure must never surface as a failure of
 * that action.
 */
const webpush = require('web-push');
const config = require('./config');
const prisma = require('./prisma');

if (config.pushEnabled) {
    webpush.setVapidDetails(config.vapid.subject, config.vapid.publicKey, config.vapid.privateKey);
}

// How long a push service may hold a message for a phone that is off or out of
// coverage. web-push's default is four weeks, which would deliver "New
// message from Sam" long after the conversation moved on; a day is plenty.
const PUSH_TTL_SECONDS = 24 * 60 * 60;

/** Sends one notification's worth of payload to every device the user has
 *  ever subscribed push on (phone + laptop both get it -- see the
 *  PushSubscription model comment). `data` becomes the JSON body the
 *  service worker's `push` handler receives; keep it small, this rides in
 *  the push itself and most push services cap payload size around 4KB.
 *
 *  Resolves to { devices, sent, failed, removed } and never throws, so the
 *  fire-and-forget callers can ignore it and POST /api/push/test can report
 *  honestly. `sent` means the push service accepted the message; whether the
 *  phone is on and shows it is out of our hands. */
async function sendPushToUser(userId, { type = 'general', title, body = '', link = '' } = {}) {
    const result = { devices: 0, sent: 0, failed: 0, removed: 0 };
    if (!config.pushEnabled || !title) return result;
    try {
        const subscriptions = await prisma.pushSubscription.findMany({ where: { userId } });
        result.devices = subscriptions.length;
        if (!subscriptions.length) return result;

        const payload = JSON.stringify({ type, title, body, link });
        await Promise.all(subscriptions.map(async (sub) => {
            try {
                await webpush.sendNotification({
                    endpoint: sub.endpoint,
                    keys: { p256dh: sub.p256dh, auth: sub.auth }
                }, payload, { TTL: PUSH_TTL_SECONDS });
                result.sent += 1;
            } catch (err) {
                // 404/410 = the push service itself says this endpoint will
                // never accept another push (uninstalled, permission
                // revoked, browser data cleared) -- delete it so it stops
                // being retried forever. Any other error (network blip,
                // 429, a push service having a bad day) is logged and left
                // alone; it might work next time.
                result.failed += 1;
                if (err.statusCode === 404 || err.statusCode === 410) {
                    result.removed += 1;
                    await prisma.pushSubscription.delete({ where: { id: sub.id } }).catch(() => {});
                } else {
                    console.error(`Push send failed (user ${userId}, status ${err.statusCode || 'n/a'}):`, err.message);
                }
            }
        }));
    } catch (err) {
        console.error('sendPushToUser failed:', err.message);
    }
    return result;
}

/** Forgets every device a person has registered. Called wherever their
 *  sessions are revoked (log out everywhere, password reset/change) or the
 *  account is suspended: those paths end the logins, but a push subscription
 *  lives in the browser's push service, not in the session, so without this
 *  the phone would keep showing message previews on a signed-out lock screen.
 *  Never throws -- it runs after the revocation itself has succeeded. Returns
 *  how many rows it removed. */
async function removeAllSubscriptionsForUser(userId) {
    try {
        const { count } = await prisma.pushSubscription.deleteMany({ where: { userId } });
        return count;
    } catch (err) {
        console.error('removeAllSubscriptionsForUser failed:', err.message);
        return 0;
    }
}

module.exports = { sendPushToUser, removeAllSubscriptionsForUser, PUSH_TTL_SECONDS };
