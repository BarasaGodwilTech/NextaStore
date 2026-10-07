'use strict';

const fs = require('fs');
const config = require('../config');

/**
 * Reads the generated facts file at answer time. The facts-sync job may replace
 * this file while the server is running, so values are intentionally not cached.
 */
function readFacts() {
    const text = fs.readFileSync(config.factsFile, 'utf8');
    const price = Number((text.match(/Seller Pass costs [A-Z]+ ([\d,]+) per month/) || [])[1]?.replace(/,/g, ''));
    const trialDays = Number((text.match(/free trial of (\d+) days/) || [])[1]);
    const blocks = ((text.match(/Coverage is bought in blocks of ([^.]+) months/) || [])[1] || '').trim();
    const example = text.match(/\(for example (\d+) months is [A-Z]+ ([\d,]+)\)/);
    const badgeLine = text.match(/A store earns a trust badge.*?: (.+)\./);
    const badgeText = badgeLine ? badgeLine[1] : '';
    const badge = {};
    for (const m of badgeText.matchAll(/([A-Za-z ]+) at (\d+) or more months/g)) badge[m[1].trim().replace(/^and\s+/i, '').toUpperCase().replace(/\s+/g, '_') + '_MONTHS'] = Number(m[2]);

    const statuses = ((text.match(/An order is always in one of these statuses: ([^.]+)\./) || [])[1] || '').trim();
    const labelsText = ((text.match(/Buyers see friendlier labels on the Orders page: ([^.]+)\./) || [])[1] || '');
    const labels = {};
    for (const m of labelsText.matchAll(/([a-z]+) is shown as "([^"]+)"/g)) labels[m[1].toUpperCase()] = m[2];

    const sellerMoves = ((text.match(/Sellers move orders along from the dashboard: ([^.]+)\./) || [])[1] || '').trim();
    const allowed = ((text.match(/A buyer can cancel an order from the Orders page only while it is ([^,]+), and only within (\d+) minutes/) || []));
    const limit =  text.match(/at most (\d+) orders? this way in any (\d+) days/);
    const fulfillment = ((text.match(/At checkout each store's items are fulfilled by ([^.]+)\./) || [])[1] || '').trim();
    const listingTypes = ((text.match(/A listing can be one of these types: ([^.]+)\./) || [])[1] || '').trim();
    const setup = text.match(/Opening a store has (\d+) steps, in this order: ([^.]+)\./);

    return {
        SUBSCRIPTION_PRICE_UGX: price,
        SUBSCRIPTION_TRIAL_DAYS: trialDays,
        SUBSCRIPTION_BLOCK_MONTHS: blocks,
        SUBSCRIPTION_EXAMPLE_MONTHS: example ? Number(example[1]) : null,
        SUBSCRIPTION_EXAMPLE_PRICE_UGX: example ? Number(example[2].replace(/,/g, '')) : null,
        BADGE_VERIFIED_SELLER_MONTHS: badge.VERIFIED_SELLER_MONTHS,
        BADGE_GOLD_PARTNER_MONTHS: badge.GOLD_PARTNER_MONTHS,
        BADGE_PLATINUM_PARTNER_MONTHS: badge.PLATINUM_PARTNER_MONTHS,
        ORDER_STATUSES: statuses,
        ORDER_STATUS_PENDING: 'pending',
        ORDER_STATUS_PROCESSING: 'processing',
        ORDER_STATUS_SHIPPED: 'shipped',
        ORDER_STATUS_DELIVERED: 'delivered',
        ORDER_STATUS_CANCELLED: 'cancelled',
        ORDER_LABEL_PENDING: labels.PENDING,
        ORDER_LABEL_PROCESSING: labels.PROCESSING,
        ORDER_LABEL_SHIPPED: labels.SHIPPED,
        ORDER_LABEL_DELIVERED: labels.DELIVERED,
        ORDER_LABEL_CANCELLED: labels.CANCELLED,
        SELLER_ORDER_MOVES: sellerMoves,
        BUYER_CANCEL_ALLOWED_STATUSES: allowed[1] || '',
        BUYER_CANCEL_WINDOW_MINUTES: allowed[2] ? Number(allowed[2]) : null,
        BUYER_CANCEL_LIMIT: limit ? Number(limit[1]) : null,
        BUYER_CANCEL_LIMIT_WINDOW_DAYS: limit ? Number(limit[2]) : null,
        FULFILLMENT_METHODS: fulfillment,
        LISTING_TYPES: listingTypes,
        ONBOARDING_STEP_COUNT: setup ? Number(setup[1]) : null,
        ONBOARDING_STEPS: setup ? setup[2] : '',
    };
}

function expand(text, facts = readFacts()) {
    return String(text || '').replace(/\{\{([A-Z0-9_]+)\}\}/g, (all, key) => {
        const value = facts[key];
        if (value === undefined || value === null || value === '') throw new Error(`Unresolved FAQ placeholder: ${key}`);
        return String(value);
    });
}

module.exports = { readFacts, expand };
