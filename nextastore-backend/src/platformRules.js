/**
 * Platform rules in one dependency-free file (no prisma, no express, no zod).
 *
 * Everything the code enforces and the assistant (Nexi) needs to describe lives
 * here, so the route that enforces a rule and the public facts endpoint
 * (`GET /api/assistant/facts`) read the same value. Change a number here and
 * Nexi follows within minutes; nobody edits a knowledge file.
 *
 * Kept free of other requires on purpose: it can be loaded by tests and by the
 * facts handler without a database.
 */

// ---- Seller Pass -----------------------------------------------------------
const SUBSCRIPTION_PRICE_UGX = 20000; // per month of coverage
const TRIAL_DAYS = 7;
// Month-blocks a seller can buy in one payment (validation.js and the facts endpoint both read this).
const SUBSCRIPTION_PERIOD_OPTIONS = [1, 3, 6, 12, 24];

// Months of paid commitment needed for each trust tier.
const TIER_MIN_MONTHS = { verified: 6, gold: 12, platinum: 24 };

// What a confirmed paid commitment actually earns on the storefront. One table,
// so the storefront, the marketplace and the subscription page can never
// disagree about a tier. `rank` is only the tier's level (1-3); it is never used
// to order listings. A badge gives a small edge over unbadged stores (see the
// orderBy in routes/store.js) but tiers are never ranked against each other.
const TIER_PERKS = {
    verified: {
        rank: 1,
        reason: `${TIER_MIN_MONTHS.verified}+ months on NextaStore`,
        perks: [
            'A Verified Seller ribbon on your store banner',
            'A trust mark on every product card',
            'Listed a step ahead of stores without a badge'
        ]
    },
    gold: {
        rank: 2,
        reason: `${TIER_MIN_MONTHS.gold}+ months on NextaStore`,
        perks: [
            'Everything in Verified Seller',
            'A gold frame on your logo and banner',
            'Gold trust marks on your products'
        ]
    },
    platinum: {
        rank: 3,
        reason: `${TIER_MIN_MONTHS.platinum}+ months on NextaStore`,
        perks: [
            'Everything in Gold Partner',
            'A platinum spotlight sheen on your banner',
            'Platinum trust marks on your products'
        ]
    }
};

const TIER_LABELS = { verified: 'Verified Seller', gold: 'Gold Partner', platinum: 'Platinum Partner' };

// ---- Orders ----------------------------------------------------------------
const ORDER_STATUSES = ['pending', 'processing', 'shipped', 'delivered', 'cancelled'];

// What buyers see on the Orders page (js/orders.js statusLabel) and what the
// seller's dashboard buttons say (js/dashboard.js sellerOrderActions). The facts
// test fails if those front-end files stop matching these.
const ORDER_STATUS_LABELS = {
    pending: 'Placed',
    processing: 'Confirmed',
    shipped: 'Shipped / ready',
    delivered: 'Completed',
    cancelled: 'Cancelled'
};
const SELLER_ACTION_LABELS = { processing: 'Confirm', delivered: 'Mark completed', cancelled: 'Cancel' };

// Seller-side moves. 'shipped' stays reachable only so an order that reached it
// before the flow was simplified can still be closed out; no new order uses it.
const ORDER_TRANSITIONS = {
    pending: ['processing', 'cancelled'],
    processing: ['delivered', 'cancelled'],
    shipped: ['delivered'],
    delivered: [],
    cancelled: []
};

// Buyer self-service cancellation (routes/orders.js POST /:id/cancel).
const CANCEL_GRACE_PERIOD_MS = 30 * 60 * 1000;             // 30 minutes from checkout
const CANCEL_ABUSE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;   // rolling 30 days
const CANCEL_ABUSE_LIMIT = 3;                              // buyer cancellations allowed per window
const BUYER_CANCELLABLE_STATUSES = ['pending', 'processing'];

const FULFILLMENT_METHODS = ['delivery', 'pickup'];
const LISTING_TYPES = ['physical', 'service', 'digital'];

// Store setup steps, in order. onboarding.html shows the same labels; the
// backend facts test fails if the page and this list drift apart.
const ONBOARDING_STEPS = ['Store Basics', 'Branding', 'Payments', 'Review & Launch'];
// js/onboarding.js sends a store with no products to the product form instead of launching.
const ONBOARDING_LAUNCH_NEEDS_PRODUCT = true;

// ---- Facts payload ---------------------------------------------------------
function minutes(ms) { return Math.round(ms / 60000); }
function days(ms) { return Math.round(ms / 86400000); }

/** Platform rules only. Never user, order or payment records. */
function buildFacts() {
    return {
        schemaVersion: 1,
        subscription: {
            currency: 'UGX',
            pricePerMonth: SUBSCRIPTION_PRICE_UGX,
            trialDays: TRIAL_DAYS,
            periodOptionsMonths: SUBSCRIPTION_PERIOD_OPTIONS.slice(),
            // Badge months count continuous paid coverage (routes/admin.js, payment approval).
            badgeCountsContinuousCoverage: true
        },
        badgeTiers: Object.keys(TIER_PERKS).map((key) => ({
            key,
            label: TIER_LABELS[key],
            minMonths: TIER_MIN_MONTHS[key],
            perks: TIER_PERKS[key].perks.slice()
        })),
        orders: {
            statuses: ORDER_STATUSES.slice(),
            statusLabels: { ...ORDER_STATUS_LABELS },
            sellerActionLabels: { ...SELLER_ACTION_LABELS },
            sellerTransitions: Object.fromEntries(Object.entries(ORDER_TRANSITIONS).map(([k, v]) => [k, v.slice()])),
            buyerCancel: {
                allowedStatuses: BUYER_CANCELLABLE_STATUSES.slice(),
                windowMinutes: minutes(CANCEL_GRACE_PERIOD_MS),
                reasonRequired: true,
                limit: CANCEL_ABUSE_LIMIT,
                limitWindowDays: days(CANCEL_ABUSE_WINDOW_MS)
            },
            fulfillmentMethods: FULFILLMENT_METHODS.slice(),
            deliveryNeedsAddress: true
        },
        listingTypes: LISTING_TYPES.slice(),
        onboardingSteps: ONBOARDING_STEPS.slice(),
        launchNeedsProduct: ONBOARDING_LAUNCH_NEEDS_PRODUCT
    };
}

module.exports = {
    SUBSCRIPTION_PRICE_UGX,
    TRIAL_DAYS,
    SUBSCRIPTION_PERIOD_OPTIONS,
    TIER_MIN_MONTHS,
    TIER_PERKS,
    TIER_LABELS,
    ORDER_STATUSES,
    ORDER_STATUS_LABELS,
    SELLER_ACTION_LABELS,
    ORDER_TRANSITIONS,
    CANCEL_GRACE_PERIOD_MS,
    CANCEL_ABUSE_WINDOW_MS,
    CANCEL_ABUSE_LIMIT,
    BUYER_CANCELLABLE_STATUSES,
    FULFILLMENT_METHODS,
    LISTING_TYPES,
    ONBOARDING_STEPS,
    ONBOARDING_LAUNCH_NEEDS_PRODUCT,
    buildFacts
};
