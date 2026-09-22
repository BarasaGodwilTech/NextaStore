const express = require('express');
const prisma = require('../prisma');
const presence = require('../presence');
const { apiError } = require('../utils');
const { isStoreCurrentlyActive } = require('../helpers');
const { requireAuth } = require('../middleware');
const { validateBody, presenceStreamSchema } = require('../validation');

const router = express.Router();

// Whether a store is visible to the public — the same rule the public store
// endpoints use (routes/store.js): published, and inside its trial or paid
// window. Anyone allowed to see the storefront may see its owner's status;
// nobody else may learn anything about it.
function isPubliclyVisible(store) {
    return !!store && !store.deletedAt && !!store.isPublished && isStoreCurrentlyActive(store);
}

/** Turns watch keys into [key, targetUserId] pairs the caller is allowed to
 *  see. Keys the caller may not see (or that do not exist) are dropped
 *  silently — the response never distinguishes "not yours" from "not found",
 *  so the endpoint cannot be used to probe for ids or slugs. */
async function resolveWatches(user, keys) {
    const conversationIds = [];
    const storeSlugs = [];
    for (const key of keys) {
        const [kind, value] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
        if (kind === 'conversation') conversationIds.push(value);
        else if (kind === 'store') storeSlugs.push(value);
    }

    const entries = [];
    const [conversations, stores] = await Promise.all([
        conversationIds.length
            ? prisma.conversation.findMany({
                // Only the conversation's two parties. This one query IS the
                // authorization check for every conversation key.
                where: { id: { in: conversationIds }, OR: [{ buyerId: user.id }, { store: { ownerId: user.id } }] },
                select: { id: true, buyerId: true, store: { select: { ownerId: true } } }
            })
            : [],
        storeSlugs.length
            ? prisma.store.findMany({
                where: { slug: { in: storeSlugs }, deletedAt: null, isPublished: true },
                select: { slug: true, ownerId: true, isPublished: true, deletedAt: true, trialEndsAt: true, subscriptionPaidUntil: true }
            })
            : []
    ]);

    for (const conv of conversations) {
        const other = conv.buyerId === user.id ? conv.store?.ownerId : conv.buyerId;
        if (other) entries.push([`conversation:${conv.id}`, other]);
    }
    for (const store of stores) {
        if (store.ownerId && isPubliclyVisible(store)) entries.push([`store:${store.slug}`, store.ownerId]);
    }
    return entries;
}

// A server-sent-events stream that does two jobs at once:
//   1. Being connected IS the caller's own presence: while this response is
//      open, they show as online to whoever is watching them.
//   2. It pushes the online/offline changes of the people they asked to
//      watch (`watch`: "conversation:<id>" / "store:<slug>" keys).
//
// It is a POST read with fetch(), not a GET read with EventSource, because
// the session is a Bearer header and EventSource cannot send headers — and a
// token in the URL would end up in the request logs (morgan).
//
// Watches are fixed for the life of a stream. To watch something else the
// page just opens a new stream (cheap), which also keeps this route
// stateless across instances.
router.post('/stream', requireAuth, validateBody(presenceStreamSchema), async (req, res, next) => {
    let conn = null;
    let ended = false;
    try {
        const entries = await resolveWatches(req.user, [...new Set(req.body.watch)]);

        // Headers are sent only after everything that can fail with a normal
        // JSON error has run.
        res.status(200);
        res.set({
            'Content-Type': 'text/event-stream; charset=utf-8',
            // requireAuth marked this no-store; a stream additionally needs
            // no-transform, which is what makes compression() leave it
            // alone (it would otherwise buffer the events until close).
            'Cache-Control': 'no-cache, no-transform',
            'X-Accel-Buffering': 'no'
        });
        if (typeof res.flushHeaders === 'function') res.flushHeaders();
        if (req.socket) {
            if (typeof req.socket.setTimeout === 'function') req.socket.setTimeout(0);
            if (typeof req.socket.setNoDelay === 'function') req.socket.setNoDelay(true);
            if (typeof req.socket.setKeepAlive === 'function') req.socket.setKeepAlive(true);
        }

        const write = (chunk) => {
            if (ended) return false;
            try { res.write(chunk); return true; } catch (err) { ended = true; return false; }
        };
        const end = (reason) => {
            if (ended) return;
            try { res.write(`event: end\ndata: ${JSON.stringify({ reason })}\n\n`); } catch (err) { /* socket already gone */ }
            ended = true;
            try { res.end(); } catch (err) { /* already ended */ }
        };
        const handle = {
            send: (event, data) => write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
            ping: () => write(': ping\n\n'),
            close: end
        };

        conn = presence.connect(req.user.id, handle);
        if (!conn) { end('shutdown'); return; }

        // 'close' on the RESPONSE: on the request it fires as soon as the
        // body has been read, not when the connection drops.
        res.on('close', () => { ended = true; presence.disconnect(conn); });

        const snapshot = await presence.watch(conn, entries);
        handle.send('snapshot', { presence: snapshot, maxAgeMs: presence.config.maxStreamAgeMs });
    } catch (err) {
        if (res.headersSent) {
            // Too late for a JSON error; end the stream and let the client's
            // own reconnect logic take over.
            if (conn) presence.disconnect(conn);
            try { res.end(); } catch (e) { /* ignore */ }
            return;
        }
        next(err);
    }
});

// One-off status of a store's owner, for a storefront header that is opened
// by somebody who is not signed in (so cannot hold a stream), and for the
// instant first paint before a stream's snapshot arrives. Public, like the
// storefront itself; never cached, because it changes by the minute.
router.get('/store/:slug', async (req, res, next) => {
    try {
        if (!/^[A-Za-z0-9_-]{1,80}$/.test(req.params.slug)) throw apiError('Store not found.', 404);
        const store = await prisma.store.findFirst({
            where: { slug: req.params.slug, deletedAt: null, isPublished: true },
            select: { slug: true, ownerId: true, isPublished: true, deletedAt: true, trialEndsAt: true, subscriptionPaidUntil: true, owner: { select: { id: true, lastActiveAt: true } } }
        });
        if (!store || !store.owner || !isPubliclyVisible(store)) throw apiError('Store not found.', 404);
        const states = await presence.describe([store.owner]);
        res.set('Cache-Control', 'no-store');
        res.json({ data: { key: `store:${store.slug}`, ...states.get(store.owner.id) } });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
module.exports.resolveWatches = resolveWatches;
