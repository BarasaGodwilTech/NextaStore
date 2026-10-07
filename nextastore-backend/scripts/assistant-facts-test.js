/**
 * Nexi's platform facts: one source of truth, served read-only.
 * No database, no express: loads platformRules.js and the handler with a fake req/res,
 * and reads the real front-end files to catch label drift.
 *
 *   node scripts/assistant-facts-test.js     (npm run test:assistant-facts)
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const out = [];
const check = (n, ok) => out.push({ n, ok: !!ok });

const rules = require('../src/platformRules');
const { factsHandler } = require('../src/assistantFacts');

function call(headers = {}) {
    const res = { code: 200, headers: {}, body: null, ended: false };
    res.set = (k, v) => { res.headers[String(k).toLowerCase()] = v; return res; };
    res.status = (c) => { res.code = c; return res; };
    res.send = (b) => { res.body = b; res.ended = true; return res; };
    res.end = () => { res.ended = true; return res; };
    factsHandler({ headers }, res);
    return res;
}

// ---- payload ---------------------------------------------------------------
const first = call();
const payload = JSON.parse(first.body).data;
check('facts handler answers 200 with JSON', first.code === 200 && /json/.test(first.headers['content-type']));
check('facts are cacheable and carry an ETag', /max-age/.test(first.headers['cache-control']) && /^"[0-9a-f]+"$/.test(first.headers.etag));
const again = call({ 'if-none-match': first.headers.etag });
check('matching If-None-Match gets a 304 with no body', again.code === 304 && again.body === null);
check('a stale ETag gets the full payload', call({ 'if-none-match': '"old"' }).code === 200);

check('price and trial come from the same constants the routes use', payload.subscription.pricePerMonth === rules.SUBSCRIPTION_PRICE_UGX && payload.subscription.trialDays === rules.TRIAL_DAYS);
check('helpers.js re-exports the very same price, trial and tier table', (() => {
    const src = read('nextastore-backend/src/helpers.js');
    return /require\('\.\/platformRules'\)/.test(src) && !/const SUBSCRIPTION_PRICE_UGX\s*=/.test(src) && !/const TRIAL_DAYS\s*=/.test(src) && !/const TIER_PERKS\s*=/.test(src);
})());
check('three tiers with months 6, 12, 24 in order', payload.badgeTiers.map((t) => t.minMonths).join() === '6,12,24' && payload.badgeTiers.map((t) => t.label).join() === 'Verified Seller,Gold Partner,Platinum Partner');
check('tier months match the thresholds used by sellerBadges', (() => {
    const src = read('nextastore-backend/src/helpers.js');
    return /commitment >= 24/.test(src) && /commitment >= 12/.test(src) && /commitment >= 6/.test(src) && payload.badgeTiers.map((t) => t.minMonths).join() === '6,12,24';
})());
check('order statuses are the five the database uses', payload.orders.statuses.join() === 'pending,processing,shipped,delivered,cancelled');
check('seller transitions: pending and processing each have two moves, final states none', payload.orders.sellerTransitions.pending.join() === 'processing,cancelled' && payload.orders.sellerTransitions.processing.join() === 'delivered,cancelled' && payload.orders.sellerTransitions.delivered.length === 0 && payload.orders.sellerTransitions.cancelled.length === 0);
check('buyer cancel rule: 30 minutes, 3 per 30 days, reason required', payload.orders.buyerCancel.windowMinutes === 30 && payload.orders.buyerCancel.limit === 3 && payload.orders.buyerCancel.limitWindowDays === 30 && payload.orders.buyerCancel.reasonRequired === true);
check('period options match what the subscription route accepts', payload.subscription.periodOptionsMonths.join() === '1,3,6,12,24' && /SUBSCRIPTION_PERIOD_OPTIONS/.test(read('nextastore-backend/src/validation.js')));

// ---- privacy ---------------------------------------------------------------
const flat = JSON.stringify(payload);
check('payload holds platform rules only: no email, phone, id or token keys', !/"(email|phone|userId|storeId|orderId|token|password|reference|address)"/i.test(flat));
check('payload is small (under 6 KB)', first.body.length < 6144);

// ---- routes enforce the shared constants -----------------------------------
const orders = read('nextastore-backend/src/routes/orders.js');
check('orders.js imports the cancel rule and transitions instead of defining them', /require\('\.\.\/platformRules'\)/.test(orders) && !/const CANCEL_GRACE_PERIOD_MS\s*=/.test(orders) && !/const CANCEL_ABUSE_LIMIT\s*=/.test(orders) && /ORDER_TRANSITIONS/.test(orders));
const validation = read('nextastore-backend/src/validation.js');
check('validation.js takes listing types and fulfilment methods from the shared rules', /LISTING_TYPES/.test(validation) && /FULFILLMENT_METHODS/.test(validation) && !/z\.enum\(\['delivery'/.test(validation));
check('facts route is mounted, public and GET-only', (() => {
    const r = read('nextastore-backend/src/routes/assistant.js');
    return /router\.get\('\/facts', factsHandler\)/.test(r) && !/requireAuth/.test(r);
})());

// ---- front-end labels cannot drift -----------------------------------------
const ordersJs = read('js/orders.js');
const labelMatch = ordersJs.match(/statusLabel\(status\)\{ return \(\{([^}]*)\}\)/);
const pageLabels = {};
if (labelMatch) for (const m of labelMatch[1].matchAll(/(\w+):'([^']*)'/g)) pageLabels[m[1]] = m[2];
check('buyer status labels on the Orders page match the facts', labelMatch && Object.keys(rules.ORDER_STATUS_LABELS).every((k) => pageLabels[k] === rules.ORDER_STATUS_LABELS[k]));
const dash = read('js/dashboard.js');
check('seller dashboard buttons match the facts', Object.entries(rules.SELLER_ACTION_LABELS).every(([st, label]) => st === 'cancelled' ? new RegExp(`targetStatus: 'cancelled', label: '${label}'`).test(dash) : new RegExp(`targetStatus: '${st}', label: '${label}'`).test(dash)));
check('Orders page grace period equals the backend window', /cancelGracePeriodMs = 30 \* 60 \* 1000/.test(ordersJs) && rules.CANCEL_GRACE_PERIOD_MS === 30 * 60 * 1000);
const stepNames = (read('js/onboarding.js').match(/this\.stepNames = \{([^}]*)\}/) || [])[1] || '';
const pageSteps = [...stepNames.matchAll(/\d+:\s*'([^']*)'/g)].map((m) => m[1]);
check('onboarding step names match the facts', pageSteps.join('|') === rules.ONBOARDING_STEPS.join('|'));
const html = read('onboarding.html');
const htmlSteps = [...html.matchAll(/onboarding-step-label">([^<]*)</g)].map((m) => m[1].replace(/&amp;/g, '&'));
check('onboarding.html step labels match the facts', htmlSteps.join('|') === rules.ONBOARDING_STEPS.join('|'));
check('onboarding sends a store with no products to the product form', rules.ONBOARDING_LAUNCH_NEEDS_PRODUCT === true && /productCount === 0/.test(read('js/onboarding.js')));

const failed = out.filter((o) => !o.ok);
out.forEach((o) => console.log((o.ok ? 'PASS  ' : 'FAIL  ') + o.n));
console.log(`\n${out.length - failed.length}/${out.length} passed`);
process.exit(failed.length ? 1 : 0);
