const express = require('express');
const prisma = require('../prisma');
const { apiError } = require('../utils');
const { notifyNewMessage } = require('../helpers');
const { requireAuth } = require('../middleware');
const presence = require('../presence');
const { validateBody, sendMessageSchema, replyMessageSchema } = require('../validation');

const router = express.Router();

// The client-supplied idempotency key (see findMessageByClientId) lives in
// the message's `metadata` JSON so no schema change is needed. It's an
// implementation detail — never sent back out.
function publicMetadata(metadata) {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || !('clientId' in metadata)) return metadata;
    const { clientId, ...rest } = metadata;
    return rest;
}

const RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;

// A send whose response never made it back (dropped connection, timeout)
// may already be stored. The client keeps one `clientId` per message across
// retries; if a message with that id from this sender is already in the
// conversation, it IS the original attempt — return it instead of inserting
// a duplicate when the sender taps Resend.
async function findMessageByClientId(conversationId, senderId, clientId) {
    if (!clientId) return null;
    const recent = await prisma.message.findMany({
        where: { conversationId, senderId, createdAt: { gte: new Date(Date.now() - RETRY_WINDOW_MS) } },
        orderBy: { createdAt: 'desc' },
        take: 50,
        include: { sender: { select: { id: true, name: true } } }
    });
    return recent.find(m => m.metadata && m.metadata.clientId === clientId) || null;
}

function withClientId(metadata, clientId) {
    return clientId ? { ...(metadata || {}), clientId } : metadata;
}

// The other person in a conversation, as { id, lastActiveAt } — the shape
// presence.describe() takes. Needs `buyer` and `store.owner` to have been
// selected (see the queries below). Only ever used server-side: ids and
// stored timestamps go in, a { online, lastActiveAt } pair comes out.
function counterpartOf(conv, userId) {
    const buyerId = conv.buyer ? conv.buyer.id : conv.buyerId;
    return buyerId === userId ? (conv.store?.owner || null) : (conv.buyer || null);
}

const PRESENCE_UNKNOWN = Object.freeze({ online: false, lastActiveAt: null });

function serializeConversation(conv, currentUserId, presenceByUserId = null) {
    const lastMessage = conv.messages[0] || null;
    const unreadCount = conv._count ? conv._count.messages : 0;
    const other = counterpartOf(conv, currentUserId);
    return {
        presence: (other && presenceByUserId && presenceByUserId.get(other.id)) || PRESENCE_UNKNOWN,
        id: conv.id,
        buyer: conv.buyer ? { id: conv.buyer.id, name: conv.buyer.name, avatar: conv.buyer.avatar || null } : null,
        store: conv.store ? { id: conv.store.id, slug: conv.store.slug, name: conv.store.name, logo: conv.store.logo } : null,
        product: conv.product ? { id: conv.product.id, name: conv.product.name, image: conv.product.image } : null,
        lastMessage: lastMessage ? { body: lastMessage.body, type: lastMessage.type, metadata: publicMetadata(lastMessage.metadata), senderId: lastMessage.senderId, createdAt: lastMessage.createdAt } : null,
        unreadCount,
        updatedAt: conv.updatedAt
    };
}

// `clientId` is the sender's own random idempotency key (see
// findMessageByClientId). It's returned so the sending client can recognise
// its own message when a background poll delivers it before the POST reply
// does, and show it once instead of twice. It carries no user data.
function serializeMessage(m) {
    const clientId = m.metadata && typeof m.metadata === 'object' && !Array.isArray(m.metadata) ? (m.metadata.clientId || null) : null;
    return { id: m.id, clientId, body: m.body, type: m.type, metadata: publicMetadata(m.metadata), senderId: m.senderId, senderName: m.sender?.name, createdAt: m.createdAt, readAt: m.readAt };
}

// Short human-readable line used for notification previews and (client
// side, mirrored in js/messages.js) the conversation list preview — a raw
// JSON metadata blob is meaningless in either place, so attachment
// messages get a description instead of their (often empty) body.
function previewText(body, type, metadata) {
    if (type === 'product') return `Shared a product${metadata?.name ? `: ${metadata.name}` : ''}`;
    if (type === 'location') return `Shared a location${metadata?.label ? `: ${metadata.label}` : ''}`;
    return body;
}

// Turns a validated `attachment` payload into the Message row's
// `type`/`metadata` pair, snapshotting whatever the bubble needs to render
// itself later without a second lookup. Only the seller who owns
// `conversation.store` may attach one of their own products — this is the
// one place that's enforced, since the write path is the only place it
// matters (a buyer can still be shown a seller's shared product fine).
async function resolveAttachment(attachment, conversation, senderId) {
    if (!attachment) return { type: 'text', metadata: {} };
    if (attachment.type === 'product') {
        if (conversation.store.ownerId !== senderId) {
            throw apiError('Only the seller can share a product from their store.', 403);
        }
        const product = await prisma.product.findFirst({
            where: { id: attachment.productId, storeId: conversation.store.id, deletedAt: null }
        });
        if (!product) throw apiError('That product is not in your store.', 404);
        return {
            type: 'product',
            metadata: {
                productId: product.id,
                name: product.name,
                price: Number(product.price),
                image: product.thumbnails?.[0] || product.image || product.images?.[0] || null,
                stock: product.stock
            }
        };
    }
    if (attachment.type === 'location') {
        return {
            type: 'location',
            metadata: { lat: attachment.lat, lng: attachment.lng, label: attachment.label || null }
        };
    }
    return { type: 'text', metadata: {} };
}

// Snapshots a product as a read-only reference card for the very first
// message of a conversation started from a product page ("Message seller"
// on product-detail.html). This is deliberately separate from the
// `resolveAttachment` "share a product" path above: that one lets a
// *seller* drop one of their own products into an existing thread and is
// ownership-gated. This one just mirrors, for the buyer, the product they
// were already looking at when they hit "Message seller" — the productId
// is never buyer-supplied in a way that matters (it's scoped to the
// store the conversation already belongs to), so no ownership check
// applies here.
async function productContextMetadata(productId, storeId) {
    if (!productId) return null;
    const product = await prisma.product.findFirst({ where: { id: productId, storeId, deletedAt: null } });
    if (!product) return null;
    return { productId: product.id, name: product.name, price: Number(product.price), image: product.thumbnails?.[0] || product.image || product.images?.[0] || null, stock: product.stock };
}

// Starts (or continues) a conversation with a seller. Called from the
// "Message seller" entry point on product-detail.html/store-detail.html.
// Whoever isn't sending becomes the recipient of a new_message notification.
router.post('/', requireAuth, validateBody(sendMessageSchema), async (req, res, next) => {
    try {
        const { storeId, productId, body, attachment, clientId } = req.body;

        const store = await prisma.store.findFirst({ where: { id: storeId, deletedAt: null } });
        if (!store) throw apiError('Store not found.', 404);
        if (!store.ownerId) throw apiError('This store has no owner to message.', 404);
        if (store.ownerId === req.user.id) throw apiError('You cannot message your own store.');
        // A buyer starting a fresh conversation can never be the store
        // owner (just checked above), so a product attachment here would
        // always fail resolveAttachment's seller-only check anyway — reject
        // it up front with a clearer message instead of a generic 403.
        if (attachment?.type === 'product') throw apiError('Only the seller can share a product from their store.', 403);

        // findFirst instead of the @@unique directly — that unique index
        // has NULL productId values which Postgres treats as never equal to
        // each other, so `findUnique` on the compound key can't be trusted
        // to find an existing general (no-product) conversation.
        const findExisting = () => prisma.conversation.findFirst({
            where: { buyerId: req.user.id, storeId: store.id, productId: productId || null }
        });
        let conversation = await findExisting();

        // A retry of a message we already stored: hand back the original
        // (200, not 201) and skip the notification/bump entirely.
        if (conversation) {
            const duplicate = await findMessageByClientId(conversation.id, req.user.id, clientId);
            if (duplicate) {
                return res.status(200).json({ data: { conversationId: conversation.id, messageId: duplicate.id, message: serializeMessage(duplicate) } });
            }
        }

        let { type, metadata } = await resolveAttachment(attachment, { store }, req.user.id);
        // No explicit attachment on this endpoint (buyers can't share a
        // product here — see the 403 above), but if the message is about a
        // specific product, show that product as a card on the message
        // itself, the same way it already shows as the conversation's
        // subtitle — so the seller (and the buyer, re-opening the thread
        // later) sees what's being asked about right in the chat, not just
        // in a header line.
        if (type === 'text' && productId) {
            const productMeta = await productContextMetadata(productId, store.id);
            if (productMeta) { type = 'product'; metadata = productMeta; }
        }
        const messageData = { senderId: req.user.id, body, type, metadata: withClientId(metadata, clientId) };

        let message = null;
        if (!conversation) {
            // Conversation and its first message are created together, so a
            // failure can't leave the seller with an empty conversation
            // ("No messages yet") from a buyer whose message never landed.
            try {
                const created = await prisma.conversation.create({
                    data: { buyerId: req.user.id, storeId: store.id, productId: productId || null, messages: { create: messageData } },
                    include: { messages: true }
                });
                conversation = created;
                message = created.messages[0];
            } catch (err) {
                // Two simultaneous first messages (double-tap, two tabs) can
                // both miss the lookup above; the loser lands here and just
                // joins the conversation the winner created.
                if (err && err.code === 'P2002') conversation = await findExisting();
                if (!conversation) throw err;
            }
        }
        if (!message) {
            // Message insert and the conversation's "last activity" bump succeed
            // or fail together — previously a failure between the two left a
            // stored message in a thread that never moved to the top of the list.
            [message] = await prisma.$transaction([
                prisma.message.create({ data: { conversationId: conversation.id, ...messageData } }),
                prisma.conversation.update({ where: { id: conversation.id }, data: { updatedAt: new Date() } })
            ]);
        }

        const preview = previewText(body, type, metadata);
        // Deliberately not awaited: createNotification already swallows its
        // own errors (see helpers.js), so there's nothing useful to do with
        // the result on this request anyway. Awaiting it here means every
        // single message send pays for a second sequential DB round trip
        // before the sender gets their response — pure added latency on the
        // hottest path in the whole feature, with zero benefit. Firing it
        // and moving on lets the notification write happen concurrently
        // with (rather than after) building the response.
        notifyNewMessage({ userId: store.ownerId, conversationId: conversation.id, senderName: req.user.name, preview, messageId: message.id });

        res.status(201).json({ data: { conversationId: conversation.id, messageId: message.id, message: serializeMessage({ ...message, sender: { name: req.user.name } }) } });
    } catch (err) {
        next(err);
    }
});

// Total unread message count across every conversation the user is a party
// to, as a single number — cheap enough to poll from every page's nav (a
// "Messages" badge in the dashboard sidebar / marketplace account menu)
// without pulling the whole conversation list down just to sum it client
// side. Mirrors the same buyer-or-owned-store membership check as
// GET /conversations below.
router.get('/unread-count', requireAuth, async (req, res, next) => {
    try {
        const ownedStore = await prisma.store.findUnique({ where: { ownerId: req.user.id } });
        const count = await prisma.message.count({
            where: {
                readAt: null,
                NOT: { senderId: req.user.id },
                conversation: {
                    OR: [
                        { buyerId: req.user.id },
                        ...(ownedStore ? [{ storeId: ownedStore.id }] : [])
                    ]
                }
            }
        });
        res.json({ data: { count } });
    } catch (err) {
        next(err);
    }
});

// Lists every conversation the current user is a party to — as the buyer,
// or as the seller of the store the conversation is with. Works the same
// way for both roles since either side can end up here.
router.get('/conversations', requireAuth, async (req, res, next) => {
    try {
        const ownedStore = await prisma.store.findUnique({ where: { ownerId: req.user.id } });
        const page = Math.max(1, Number(req.query.page) || 1);
        const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
        const where = {
            OR: [
                { buyerId: req.user.id },
                ...(ownedStore ? [{ storeId: ownedStore.id }] : [])
            ]
        };

        const [conversations, total] = await Promise.all([
            prisma.conversation.findMany({
                where,
                include: {
                    buyer: { select: { id: true, name: true, avatar: true, lastActiveAt: true } },
                    store: { select: { id: true, slug: true, name: true, logo: true, owner: { select: { id: true, lastActiveAt: true } } } },
                    product: { select: { id: true, name: true, image: true } },
                    messages: { orderBy: { createdAt: 'desc' }, take: 1 },
                    _count: { select: { messages: { where: { readAt: null, NOT: { senderId: req.user.id } } } } }
                },
                orderBy: { updatedAt: 'desc' },
                skip: (page - 1) * limit,
                take: limit
            }),
            prisma.conversation.count({ where })
        ]);

        // Everyone's current status in one lookup (a single Redis round trip
        // when Redis is configured, none otherwise).
        const others = conversations.map(c => counterpartOf(c, req.user.id)).filter(Boolean);
        const presenceByUserId = await presence.describe(others);

        res.json({
            data: conversations.map(c => serializeConversation(c, req.user.id, presenceByUserId)),
            pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 }
        });
    } catch (err) {
        next(err);
    }
});

// `withMeta` also pulls the buyer and product, used by the full (non-poll)
// thread response so the client can draw the header even when the
// conversation isn't in the first page of its list (e.g. a deep link from a
// notification to an older thread). Polls skip the extra joins.
async function loadConversationForUser(conversationId, userId, { withMeta = false } = {}) {
    const conversation = await prisma.conversation.findUnique({
        where: { id: conversationId },
        // The other party's stored last-active time rides along in both modes
        // (opens and 8-second polls): it is what lets the header show
        // "Active 5m ago" even if the live stream is blocked by a proxy.
        include: withMeta
            ? {
                store: { include: { owner: { select: { id: true, lastActiveAt: true } } } },
                buyer: { select: { id: true, name: true, avatar: true, lastActiveAt: true } },
                product: { select: { id: true, name: true, image: true } }
            }
            : {
                store: { include: { owner: { select: { id: true, lastActiveAt: true } } } },
                buyer: { select: { id: true, lastActiveAt: true } }
            }
    });
    if (!conversation) return null;
    const isBuyer = conversation.buyerId === userId;
    const isSeller = conversation.store.ownerId === userId;
    if (!isBuyer && !isSeller) return null;
    return conversation;
}

// { online, lastActiveAt } for the other person in an already-loaded thread.
async function threadPresence(conversation, userId) {
    const other = counterpartOf(conversation, userId);
    if (!other) return PRESENCE_UNKNOWN;
    const states = await presence.describe([other]);
    return states.get(other.id) || PRESENCE_UNKNOWN;
}

// A single thread's messages, oldest first. Marks every message from the
// other party as read as a side effect of opening it — simple polling (per
// the prompt) rather than push, so "read" only updates when the reader
// actually re-fetches.
//
// Two distinct fetch modes share this route:
//   - `before` (existing): "load older messages" when scrolling up —
//     paginates backwards from a cursor, capped at `limit`.
//   - `since` (new): "what's new since I last checked" — used by the
//     client's poll loop while a thread stays open. Without this, every 8s
//     poll re-requested and the client re-rendered the full most-recent
//     `limit` (up to 100) messages from scratch, every time, for every open
//     thread — constant, ever-repeated work completely independent of
//     whether anything actually changed. `since` returns only messages
//     newer than the given timestamp (uncapped-but-sane, see MAX below),
//     so an idle open thread costs a near-empty response every poll instead
//     of the same ~100-message payload and full-array re-serialization
//     over and over. `serverTime` is returned alongside so the client
//     anchors its next cursor to *this server's* clock rather than the
//     newest message's createdAt — avoiding a gap (or duplicate refetch)
//     from client/server clock skew or same-millisecond timestamp ties.
/* One handler, two routes (below). `peekOnly` is the side-effect-free twin:
   it neither stamps the other party's messages read nor settles the thread's
   bell notification. The client uses it to PREFETCH a thread on a hover /
   touch-down / focus on a conversation row — an intent signal, not a read;
   without it, sweeping the mouse across the list would send read receipts to
   every sender it crossed and clear their unread badges.

   It is a separate PATH (GET /conversations/:id/peek) rather than a query
   flag on purpose: a server that predates this change 404s on the new path
   and the prefetch just fails harmlessly, whereas an old server would ignore
   an unknown `?peek=1` and quietly mark the thread read — so the frontend
   and backend can be deployed in either order. */
const conversationGetHandler = (peekOnly) => async (req, res, next) => {
    try {
        const since = req.query.since ? new Date(req.query.since) : null;
        const isSincePoll = since && !Number.isNaN(since.getTime());
        const conversation = await loadConversationForUser(req.params.id, req.user.id, { withMeta: !isSincePoll });
        if (!conversation) throw apiError('Conversation not found.', 404);

        const requestReceivedAt = new Date();
        const peek = peekOnly;   // see conversationGetHandler above; authorization (loadConversationForUser) is identical
        // Marking the other party's messages read no longer runs BEFORE the
        // fetch: the two are independent, so they go out together instead
        // of stacking a second database round trip in front of every open
        // and every 8-second poll. (The messages returned may still show
        // readAt: null for the other party's messages on this one response —
        // nothing renders a read receipt for messages you didn't send.)
        const markReadPromise = peek ? Promise.resolve({ count: 0 }) : prisma.message.updateMany({
            where: { conversationId: conversation.id, readAt: null, NOT: { senderId: req.user.id } },
            data: { readAt: requestReceivedAt }
        }).then(result => {
            // Reading the thread also settles its bell notification, so the
            // badge doesn't stay lit for messages already read in-thread.
            if (result.count > 0) {
                prisma.notification.updateMany({
                    where: { userId: req.user.id, type: 'new_message', link: `messages.html?conversation=${conversation.id}`, readAt: null },
                    // Opening the thread settles both the item's own unread
                    // state and its contribution to the bell badge — there's
                    // no separate "acknowledge" gesture to wait for once the
                    // notification's actual target has been read in full.
                    data: { readAt: requestReceivedAt, acknowledgedAt: requestReceivedAt }
                }).catch(err => console.error('Failed to settle message notification:', err));
            }
            return result;
        });

        if (isSincePoll) {
            // Bounded even though this is "unbounded since X" — a thread
            // that's been open long enough to fall far behind (laptop
            // asleep, phone locked for hours) still gets a fast, capped
            // response; the client falls back to a full reload if it needs
            // more than this to catch up, same as any other truncated feed.
            const SINCE_POLL_CAP = 200;
            // Two independent things can have changed since the caller's
            // last check: new messages (from either party), and read
            // receipts flipping on messages *this user* sent that the
            // other party has since opened. The mark-as-read UPDATE above
            // only ever touches the other party's messages, never this
            // user's own — so any of this user's own messages with
            // `readAt` in (since, now] must have been flipped by the OTHER
            // party's own poll/open in between, which is exactly the
            // read-receipt tick the client needs to update without
            // re-fetching messages it already has.
            // Both windows reach back a few seconds before the caller's
            // cursor. A row written just before `since` can commit just
            // AFTER the previous poll's query ran, and would otherwise fall
            // in the gap and never be delivered (a message that only shows
            // up after a refresh, or a receipt that never ticks). The
            // client de-duplicates by id and applies read receipts
            // idempotently, so re-delivering a few rows is harmless.
            const OVERLAP_MS = 5000;
            const sinceWithOverlap = new Date(since.getTime() - OVERLAP_MS);
            const [newMessages, readUpdates] = await Promise.all([
                prisma.message.findMany({
                    where: { conversationId: conversation.id, createdAt: { gt: sinceWithOverlap } },
                    orderBy: { createdAt: 'asc' },
                    take: SINCE_POLL_CAP,
                    include: { sender: { select: { id: true, name: true } } }
                }),
                prisma.message.findMany({
                    where: { conversationId: conversation.id, senderId: req.user.id, readAt: { gt: sinceWithOverlap } },
                    select: { id: true, readAt: true }
                }),
                markReadPromise
            ]);
            return res.json({
                data: {
                    id: conversation.id,
                    store: { id: conversation.store.id, name: conversation.store.name, slug: conversation.store.slug },
                    presence: await threadPresence(conversation, req.user.id),
                    messages: newMessages.map(serializeMessage),
                    readUpdates,
                    pagination: { mode: 'since', serverTime: requestReceivedAt, truncated: newMessages.length === SINCE_POLL_CAP }
                }
            });
        }

        const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 100));
        const before = req.query.before ? new Date(req.query.before) : null;
        const messageWhere = {
            conversationId: conversation.id,
            ...(before && !Number.isNaN(before.getTime()) ? { createdAt: { lt: before } } : {})
        };
        const [messages] = await Promise.all([
            prisma.message.findMany({
                where: messageWhere,
                orderBy: { createdAt: 'desc' },
                take: limit + 1,
                include: { sender: { select: { id: true, name: true } } }
            }),
            markReadPromise
        ]);
        const hasMore = messages.length > limit;
        const pageMessages = messages.slice(0, limit).reverse();
        const nextBefore = pageMessages[0]?.createdAt || null;

        res.json({
            data: {
                id: conversation.id,
                store: { id: conversation.store.id, name: conversation.store.name, slug: conversation.store.slug, logo: conversation.store.logo },
                buyer: conversation.buyer ? { id: conversation.buyer.id, name: conversation.buyer.name, avatar: conversation.buyer.avatar || null } : null,
                product: conversation.product ? { id: conversation.product.id, name: conversation.product.name, image: conversation.product.image } : null,
                presence: await threadPresence(conversation, req.user.id),
                messages: pageMessages.map(serializeMessage),
                pagination: { mode: 'page', limit, hasMore, nextBefore, serverTime: requestReceivedAt }
            }
        });
    } catch (err) {
        next(err);
    }
};
router.get('/conversations/:id', requireAuth, conversationGetHandler(false));
router.get('/conversations/:id/peek', requireAuth, conversationGetHandler(true));

router.post('/conversations/:id', requireAuth, validateBody(replyMessageSchema), async (req, res, next) => {
    try {
        const conversation = await loadConversationForUser(req.params.id, req.user.id);
        if (!conversation) throw apiError('Conversation not found.', 404);

        const { clientId } = req.body;
        const duplicate = await findMessageByClientId(conversation.id, req.user.id, clientId);
        if (duplicate) return res.status(200).json({ data: serializeMessage(duplicate) });

        const { type, metadata } = await resolveAttachment(req.body.attachment, conversation, req.user.id);
        const [message] = await prisma.$transaction([
            prisma.message.create({
                data: { conversationId: conversation.id, senderId: req.user.id, body: req.body.body, type, metadata: withClientId(metadata, clientId) }
            }),
            prisma.conversation.update({ where: { id: conversation.id }, data: { updatedAt: new Date() } })
        ]);

        const preview = previewText(req.body.body, type, metadata);
        const recipientId = conversation.buyerId === req.user.id ? conversation.store.ownerId : conversation.buyerId;
        if (recipientId) {
            // Not awaited — see the identical note on POST / above.
            notifyNewMessage({ userId: recipientId, conversationId: conversation.id, senderName: req.user.name, preview, messageId: message.id });
        }

        res.status(201).json({ data: serializeMessage({ ...message, sender: { name: req.user.name } }) });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
