const prisma = require('./prisma');
const config = require('./config');
const { sendPushToUser } = require('./push');

/** Computes the denormalized Product.onSale flag from a price/originalPrice
 *  pair. Call this any time either field is written (create, or an update
 *  that touches either one) so the stored flag never drifts from what the
 *  two Decimal columns actually say — the /deals endpoint filters on this
 *  column directly instead of re-deriving it in JS on every request. */
function computeOnSale(price, originalPrice) {
    if (originalPrice === null || originalPrice === undefined) return false;
    return Number(originalPrice) > Number(price);
}

/** Every product/order money field comes back from Prisma as a Decimal
 *  instance — the frontend expects plain numbers (it does arithmetic like
 *  `p.originalPrice > p.price` directly on the JSON). Convert at the edge,
 *  once, instead of scattering Number(...) calls through every route. */
function serializeProduct(p) {
    if (!p) return p;
    // `thumbnail` (singular) is a convenience field for grid/list rendering
    // (item 5): the first generated thumbnail, or the full image for any
    // product saved before thumbnails existed. See app.productThumb() on
    // the frontend, which is the only place this should be read from.
    const thumbnail = (Array.isArray(p.thumbnails) && p.thumbnails[0]) || p.image || null;
    return {
        ...p,
        thumbnail,
        price: p.price === null || p.price === undefined ? p.price : Number(p.price),
        originalPrice: p.originalPrice === null || p.originalPrice === undefined ? null : Number(p.originalPrice)
    };
}

function sellerBadges(store, { productCount = null } = {}) {
    if (!store) return [];
    const subscription = subscriptionInfo(store);
    const commitment = Number(store.badgeCommitmentMonths || 0);
    const badges = [];

    // Primary trust badge: only a confirmed paid commitment of 6+ months.
    if (subscription?.isPaid && !!store.verified && commitment >= 6) {
        if (commitment >= 24) {
            badges.push({ key: 'platinum-partner', label: 'Platinum Partner', shortLabel: 'Platinum', icon: 'fa-gem', tone: 'platinum', reason: '24+ month confirmed commitment' });
        } else if (commitment >= 12) {
            badges.push({ key: 'gold-partner', label: 'Gold Partner', shortLabel: 'Gold', icon: 'fa-crown', tone: 'gold', reason: '12+ month confirmed commitment' });
        } else {
            badges.push({ key: 'verified-seller', label: 'Verified Seller', shortLabel: 'Verified', icon: 'fa-circle-check', tone: 'verified', reason: '6+ month confirmed commitment' });
        }
    }

    // A separate operational badge, deliberately not a trust/rating claim.
    // It is earned from visible storefront completeness rather than sales.
    const completeProfile = !!store.logo
        && String(store.description || '').trim().length >= 30
        && !!String(store.district || store.address || '').trim()
        && (productCount === null || Number(productCount) > 0);
    if (completeProfile) {
        badges.push({ key: 'store-ready', label: 'Store Ready', shortLabel: 'Store Ready', icon: 'fa-store', tone: 'ready', reason: 'Storefront profile and catalog are ready' });
    }

    return badges;
}

function primarySellerBadge(store, context = {}) {
    return sellerBadges(store, context)[0] || null;
}

function serializeOrder(o) {
    if (!o) return o;
    const serialized = {
        ...o,
        total: Number(o.total),
        fulfillmentMethod: o.fulfillmentMethod || 'delivery',
        paymentMethod: o.paymentMethod || null,
        paymentStatus: o.paymentStatus || 'unpaid',
        flaggedAt: o.flaggedAt || null,
        flagReason: o.flagReason || null,
        items: Array.isArray(o.items)
            ? o.items.map(i => ({
                productId: i.productId,
                productName: i.productName,
                quantity: i.quantity,
                unitPrice: Number(i.unitPrice)
            }))
            : undefined
    };
    if (serialized.store) {
        const storeSubscription = subscriptionInfo(serialized.store);
        serialized.store = {
            ...serialized.store,
            // A verified badge is earned by an approved paid subscription,
            // never by a stale/manual flag after the paid period expires.
            verified: !!serialized.store.verified && !!storeSubscription?.isPaid && Number(serialized.store.badgeCommitmentMonths || 0) >= 6,
            // Buyer-facing (order history), so drop the seller-only "Store
            // Ready" operational badge the same way serializePublicStore does.
            badges: sellerBadges(serialized.store).filter(b => b.key !== 'store-ready')
        };
    }
    return serialized;
}

// Monthly subscription price for the paid "verified seller" badge.
const SUBSCRIPTION_PRICE_UGX = 20000;
const TRIAL_DAYS = 7;

/** Derived, read-only view of a store's subscription state. Always
 *  recomputed from the actual trialEndsAt/subscriptionPaidUntil dates
 *  rather than trusting the stored subscriptionStatus column alone, so a
 *  lapsed trial/subscription reads as expired immediately everywhere —
 *  dashboard, admin, marketplace visibility — without needing a cron job to
 *  go sweep and flip a status column first. */
function subscriptionInfo(store) {
    if (!store) return null;
    const now = Date.now();
    const trialEndsAt = store.trialEndsAt ? new Date(store.trialEndsAt) : null;
    const paidUntil = store.subscriptionPaidUntil ? new Date(store.subscriptionPaidUntil) : null;
    const inTrial = !!trialEndsAt && trialEndsAt.getTime() > now;
    const isPaid = !!paidUntil && paidUntil.getTime() > now;
    const active = inTrial || isPaid;
    const status = isPaid ? 'active' : (inTrial ? 'trial' : 'expired');
    const untilDate = isPaid ? paidUntil : trialEndsAt;
    const daysLeft = active && untilDate ? Math.max(0, Math.ceil((untilDate.getTime() - now) / 86400000)) : 0;
    const commitmentMonths = isPaid ? Math.max(0, Number(store.badgeCommitmentMonths || 0)) : 0;
    const badge = isPaid && !!store.verified && commitmentMonths >= 6
        ? commitmentMonths >= 24
            ? { key: 'platinum-partner', label: 'Platinum Partner', shortLabel: 'Platinum', icon: 'fa-gem', tone: 'platinum', reason: '24+ months of active paid coverage' }
            : commitmentMonths >= 12
                ? { key: 'gold-partner', label: 'Gold Partner', shortLabel: 'Gold', icon: 'fa-crown', tone: 'gold', reason: '12+ months of active paid coverage' }
                : { key: 'verified-seller', label: 'Verified Seller', shortLabel: 'Verified', icon: 'fa-circle-check', tone: 'verified', reason: '6+ months of active paid coverage' }
        : null;
    const nextThreshold = commitmentMonths < 6 ? 6 : commitmentMonths < 12 ? 12 : commitmentMonths < 24 ? 24 : null;
    return {
        status, active, isPaid, inTrial,
        trialEndsAt: trialEndsAt ? trialEndsAt.toISOString() : null,
        subscriptionPaidUntil: paidUntil ? paidUntil.toISOString() : null,
        daysLeft,
        priceUgx: SUBSCRIPTION_PRICE_UGX,
        commitmentMonths,
        badge,
        nextBadgeMonths: nextThreshold,
        monthsToNextBadge: nextThreshold ? Math.max(0, nextThreshold - commitmentMonths) : 0
    };
}

// How often an automatic trial/expiry reminder can re-fire for the same
// store + same message. Keeps a seller who opens the dashboard/subscription
// page repeatedly in one day from getting a fresh bell entry and push on
// every single load, while still letting a *changed* message through right
// away (3 days left -> 1 day left -> expired are each a new title, so each
// gets its own reminder as soon as it's true, rather than waiting out the
// cooldown from the last one).
const SUBSCRIPTION_REMINDER_COOLDOWN_MS = 20 * 60 * 60 * 1000; // ~20h

/** Opportunistic subscription reminder, checked wherever a seller's own
 *  store gets loaded (GET /store, GET /subscription) — the same
 *  "recompute from trialEndsAt/subscriptionPaidUntil, don't sweep with a
 *  cron job" approach subscriptionInfo() already uses for the status itself,
 *  applied to notifying about it too. Reuses the existing 'subscription'
 *  NotificationType (already used for admin payment-review notifications,
 *  see routes/admin.js) so this needs no schema change, and goes through
 *  createNotification so it becomes both a bell entry and a push, matching
 *  the wording of the dashboard's own trial-ending banner. Never throws —
 *  same contract as createNotification, since a reminder failing to send
 *  must never take down the store-load request that triggered it. */
async function maybeNotifySubscriptionReminder(store) {
    try {
        if (!store || !store.ownerId) return;
        const sub = subscriptionInfo(store);
        const isExpired = sub.status === 'expired';
        const isEndingSoon = sub.status === 'trial' && sub.daysLeft <= 3;
        if (!isExpired && !isEndingSoon) return;

        const title = isExpired
            ? 'Your store is currently hidden from shoppers'
            : `Your free trial ends in ${sub.daysLeft} day${sub.daysLeft === 1 ? '' : 's'}`;
        const body = isExpired
            ? 'Your trial ended and no subscription payment has been confirmed yet. Renew your Seller Pass to return to the marketplace; a 6+ month commitment restores a seller badge after approval.'
            : `Start your Seller Pass at UGX ${sub.priceUgx.toLocaleString('en-UG')}/month. Choose 6+ months to earn a seller badge and keep your store visible when the trial ends.`;
        const link = '/subscription.html';

        const recent = await prisma.notification.findFirst({
            where: {
                userId: store.ownerId,
                type: 'subscription',
                link,
                title,
                createdAt: { gt: new Date(Date.now() - SUBSCRIPTION_REMINDER_COOLDOWN_MS) }
            },
            select: { id: true }
        });
        if (recent) return; // already reminded with this exact message recently

        await createNotification({ userId: store.ownerId, type: 'subscription', title, body, link });
    } catch (err) {
        console.error('Failed to send subscription reminder notification:', err);
    }
}

/** Whether a store should currently be visible/purchasable to shoppers. The
 *  owner previewing/managing their own store is never gated by this — see
 *  the ownership check at each call site in routes/store.js. */
function isStoreCurrentlyActive(store) {
    if (!store) return false;
    const now = Date.now();
    const trialOk = !!store.trialEndsAt && new Date(store.trialEndsAt).getTime() > now;
    const paidOk = !!store.subscriptionPaidUntil && new Date(store.subscriptionPaidUntil).getTime() > now;
    return trialOk || paidOk;
}

/** The shareable, search-engine-visible address of a store (see routes/seo.js). */
function storePublicUrl(slug) {
    return slug ? `${config.siteUrl}/s/${encodeURIComponent(slug)}` : null;
}

function serializeStore(s, context = {}) {
    if (!s) return s;
    const subscription = subscriptionInfo(s);
    const verified = !!s.verified && subscription.isPaid && Number(s.badgeCommitmentMonths || 0) >= 6;
    return { ...s, verified, publicUrl: storePublicUrl(s.slug), badges: sellerBadges({ ...s, verified }, context), subscription };
}

/** Public storefront payload. Never expose ownership, account contact data,
 * internal SEO/analytics settings, or other seller-only fields to shoppers.
 * The "Store Ready" badge is an operational nudge for the seller (it tells
 * *them* their profile is complete enough to look good) — not a trust
 * signal for shoppers, so it's stripped here even though sellerBadges()
 * still includes it for the seller's own dashboard (serializeStore). */
function serializePublicStore(s, context = {}) {
    if (!s) return s;
    const subscription = subscriptionInfo(s);
    const verified = !!s.verified && subscription.isPaid && Number(s.badgeCommitmentMonths || 0) >= 6;
    return {
        id: s.id,
        slug: s.slug,
        name: s.name,
        description: s.description,
        theme: s.theme,
        layout: s.layout,
        logo: s.logo,
        banner: s.banner,
        bannerColor: s.bannerColor,
        district: s.district,
        detailedDirections: s.detailedDirections,
        mapCoordinates: s.mapCoordinates,
        payments: s.payments,
        publicUrl: storePublicUrl(s.slug),
        followers: s.followers,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        verified,
        badges: sellerBadges({ ...s, verified }, context).filter(b => b.key !== 'store-ready')
    };
}

async function getStoreForUser(userId) {
    if (!userId) return null;
    return prisma.store.findUnique({ where: { ownerId: userId } });
}

/**
 * Resolve which store a request is about. Storefront pages pass ?store=<slug>
 * for a specific store; the dashboard pages pass no slug and
 * rely on the authenticated user's own store. There is no more implicit
 * "demo store" fallback — a request that resolves to nothing real is a 404,
 * not a stand-in.
 *
 * Accepts either a store's slug or its id in ?store= — different pages on
 * the frontend link to a store using whichever one they have on hand, so
 * this matches both instead of forcing every caller onto one format.
 */
async function resolveContextStore(req) {
    const slugOrId = req.query && req.query.store;
    if (slugOrId) {
        const match = await prisma.store.findFirst({
            where: { deletedAt: null, OR: [{ slug: slugOrId }, { id: slugOrId }] }
        });
        if (match) return match;
    }
    if (req.user) {
        const owned = await getStoreForUser(req.user.id);
        if (owned) return owned;
    }
    return null;
}

function publicUser(user) {
    return {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        accountStatus: user.accountStatus || 'active',
        adminLevel: user.adminLevel || 'standard',
        adminRole: user.adminRole ? { id: user.adminRole.id, name: user.adminRole.name, permissions: user.adminRole.permissions || [] } : null,
        avatar: user.avatar || null,
        cover: user.cover || null,
        emailVerified: !!user.emailVerifiedAt
    };
}

async function recordAdminAudit({ actorId, action, targetType, targetId = null, targetUserId = null, metadata = {} }) {
    try {
        await prisma.adminAuditLog.create({ data: { actorId, action, targetType, targetId, targetUserId, metadata } });
    } catch (err) {
        console.error('Failed to write admin audit log:', err);
    }
}

/** Single place notifications get created from — new orders, new messages,
 *  low stock (see orders.js, messages.js, products.js) — so the shape of a
 *  notification row never drifts between call sites. Never throws: a
 *  notification failing to write should never take down the action that
 *  triggered it (placing an order, sending a message). */
async function createNotification({ userId, type, title, body = '', link = '' }) {
    try {
        await prisma.notification.create({ data: { userId, type, title, body, link } });
    } catch (err) {
        console.error('Failed to create notification:', err);
    }
    // Fire-and-forget: a push failing (or not being configured at all)
    // must never affect whether the in-app notification/bell got created,
    // which is why this runs after that write, not inside its try/catch.
    sendPushToUser(userId, { type, title, body, link });
}

/** One notification per conversation, not one per message.
 *
 *  Every message used to insert its own "New message from X" row, so a
 *  ten-message back-and-forth put ten near-identical entries in the bell —
 *  enough to push real notifications (new orders) out of the 30-row window
 *  the dropdown shows. While the recipient still hasn't seen the previous
 *  one, this refreshes it in place (latest preview, bumped to the top) and
 *  only creates a new row once the last one has been read. Same
 *  never-throws contract as createNotification. */
async function notifyNewMessage({ userId, conversationId, senderName, preview, messageId = null }) {
    try {
        // This runs after the sender's response has gone out. If the
        // recipient already has the thread open, their poll may have marked
        // the message read in the meantime — a bell notification for a
        // message they've already seen would just be a stuck badge.
        if (messageId) {
            const stored = await prisma.message.findUnique({ where: { id: messageId }, select: { readAt: true } });
            if (stored && stored.readAt) return;
        }
        const link = `messages.html?conversation=${conversationId}`;
        const title = `New message from ${senderName}`;
        const body = preview.length > 120 ? `${preview.slice(0, 117)}...` : preview;
        const existing = await prisma.notification.findFirst({
            where: { userId, type: 'new_message', link, readAt: null },
            select: { id: true }
        });
        if (existing) {
            // New content bumps it back to the top of the bell — also
            // un-acknowledge it (even if the person already opened the bell
            // once and this row's badge-contribution had cleared) so the
            // badge re-lights for the fresh message rather than staying
            // silently at 0 for an item that now has new, unseen content.
            await prisma.notification.update({ where: { id: existing.id }, data: { title, body, createdAt: new Date(), acknowledgedAt: null } });
        } else {
            await prisma.notification.create({ data: { userId, type: 'new_message', title, body, link } });
        }
        // Every new message pushes, even when it's bumping an existing bell
        // row rather than creating a new one — a buyer/seller who's away
        // from the app should feel each reply arrive, not just the first
        // one in a back-and-forth.
        sendPushToUser(userId, { type: 'new_message', title, body, link });
    } catch (err) {
        console.error('Failed to create message notification:', err);
    }
}

/** Fans a "new product" notification out to every follower of the store
 *  that just added it. Unlike createNotification (one row, one push, one
 *  recipient) this writes every follower's Notification row in a single
 *  createMany rather than one insert per follower -- a store with a few
 *  thousand followers must not turn "add a product" into a few thousand
 *  sequential round trips. Push still goes out to each follower
 *  individually afterward, since sendPushToUser's own device fan-out is
 *  already per-user (see push.js) and there's no batch-push equivalent.
 *
 *  Same never-throws contract as createNotification, and deliberately not
 *  awaited by its caller (POST /products, same reasoning as
 *  notifyNewMessage in routes/messages.js) so a big following never adds
 *  latency to the seller's own "product created" response.
 *
 *  Skips the store's own owner: StoreFollow doesn't currently stop someone
 *  from following their own store, and "your store just added a product"
 *  is not news to the person who added it. */
async function notifyStoreFollowersOfNewProduct({ storeId, storeName, storeSlug, storeOwnerId, productId, productName }) {
    try {
        const followers = await prisma.storeFollow.findMany({
            where: { storeId, ...(storeOwnerId ? { userId: { not: storeOwnerId } } : {}) },
            select: { userId: true }
        });
        if (!followers.length) return; // nothing to write or send -- common case for a brand-new store

        const title = `${storeName} added a new product`;
        // Same 120-char guard notifyNewMessage uses for a message preview --
        // product name has no schema-level max length (validation.js only
        // requires non-empty), so this is the only thing keeping a title
        // written by the seller from blowing out the bell's layout.
        const body = productName.length > 120 ? `${productName.slice(0, 117)}...` : productName;
        const link = `product-detail.html?id=${productId}&store=${encodeURIComponent(storeSlug || '')}`;

        await prisma.notification.createMany({
            data: followers.map(f => ({ userId: f.userId, type: 'new_product', title, body, link }))
        });

        await Promise.all(followers.map(f => sendPushToUser(f.userId, { type: 'new_product', title, body, link })));
    } catch (err) {
        console.error('Failed to notify store followers of new product:', err);
    }
}

/** Active payment-method catalog for the checkout screen (GET
 *  /api/payments/methods). Filters out anything platform-disabled and, in
 *  production, anything an admin has left in 'test' to stage it. Shared
 *  between the public route and anywhere else server-side that needs to
 *  validate a submitted paymentMethod code against what's actually offered
 *  (see orders.js). */
async function getActivePaymentMethods() {
    return prisma.paymentMethod.findMany({
        where: {
            isActive: true,
            environment: config.isProd ? 'live' : { in: ['live', 'test'] }
        },
        orderBy: { sortOrder: 'asc' }
    });
}

/** Fetches the single platform settings row, creating it with defaults on
 *  first read if it doesn't exist yet (e.g. a fresh deploy before any admin
 *  has opened the settings panel). */
async function getPlatformSettings() {
    return prisma.platformSettings.upsert({ where: { id: 'singleton' }, update: {}, create: { id: 'singleton' } });
}

module.exports = {
    getStoreForUser,
    resolveContextStore,
    publicUser,
    recordAdminAudit,
    createNotification,
    notifyNewMessage,
    notifyStoreFollowersOfNewProduct,
    maybeNotifySubscriptionReminder,
    serializeProduct,
    computeOnSale,
    serializeOrder,
    serializeStore,
    serializePublicStore,
    subscriptionInfo,
    isStoreCurrentlyActive,
    getPlatformSettings,
    getActivePaymentMethods,
    SUBSCRIPTION_PRICE_UGX,
    TRIAL_DAYS
};
