#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const backend = path.join(root, 'nextastore-backend');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const checks = [];
function check(name, ok, detail='') { checks.push({name, ok, detail}); }

const storeDetail = read('js/store-detail.js');
const cart = read('js/cart.js');
const cartPage = read('js/cart-page.js');
const orders = read('js/orders.js');
const dashboard = read('js/dashboard.js');
const schema = read('nextastore-backend/prisma/schema.prisma');
const validation = read('nextastore-backend/src/validation.js');
const orderRoutes = read('nextastore-backend/src/routes/orders.js');
const app = read('nextastore-backend/src/app.js');
const adminMigration = read('nextastore-backend/prisma/migrations/20260911093000_admin_moderation/migration.sql');
const adminRoute = read('nextastore-backend/src/routes/admin.js');
const middleware = read('nextastore-backend/src/middleware.js');

const renderIndex = storeDetail.indexOf('renderProducts()');
const listenerIndex = storeDetail.indexOf('setupProductEventListeners()');
check('Delegated product-grid listener is not bound from renderProducts',
  listenerIndex >= 0 && renderIndex >= 0 && listenerIndex < renderIndex,
  'The cart click handler should be initialized once, before repeated renders.');
check('Shared cart uses localStorage', /nextastore_cart_v1/.test(cart));
check('Shared cart supports cross-tab storage sync', /addEventListener\(['"]storage['"]/.test(cart));
check('Batch checkout route exists', /router\.post\(['"]\/batch['"]/.test(orderRoutes));
check('Batch checkout is transactional', /prisma\.\$transaction\(async \(tx\)/.test(orderRoutes));
check('Checkout requires acknowledgment', /acknowledgment:\s*z\.literal\(true\)/.test(validation));
check('Fulfillment enum exists in Prisma', /enum FulfillmentMethod[\s\S]*delivery[\s\S]*pickup/.test(schema));
check('Order stores fulfillment method', /fulfillmentMethod\s+FulfillmentMethod/.test(schema));
check('Order stores payment status', /paymentStatus\s+PaymentStatus/.test(schema));
check('Order reports are persisted', /model OrderReport/.test(schema) && /orderReport\.create/.test(orderRoutes));
check('Report endpoint is authenticated', /router\.post\(['"]\/:id\/report['"],\s*requireAuth/.test(orderRoutes));
check('Trust & Safety page exists', fs.existsSync(path.join(root, 'safety.html')));
check('Checkout links to Trust & Safety', /href="\/safety"/.test(cartPage));
check('Buyer orders expose reporting UI', /report/i.test(orders));
check('Seller dashboard exposes reporting UI', /report/i.test(dashboard));
check('Store directory uses seller badges', /renderSellerBadges/.test(read('js/stores.js')));
check('Store detail uses verification signal', /verified/i.test(storeDetail));
check('Admin migration uses valid plain SQL enum value', /ALTER TYPE \"UserRole\" ADD VALUE IF NOT EXISTS 'admin';/.test(adminMigration) && !/\"'\"'admin'\"'\"'/.test(adminMigration));
check('Reports route is mounted through orders router', /app\.use\(['"]\/api\/orders['"],\s*orderRoutes\)/.test(app));
check('Admin moderation routes are server-side gated', /requireAdmin/.test(adminRoute) && /requireAuth/.test(adminRoute));
check('Seller-only backend middleware remains seller-only', /req\.user\.role !== 'seller'/.test(middleware) && !/!\['seller', 'admin'\]\.includes\(req\.user\.role\)/.test(middleware));
const integration = read('nextastore-backend/scripts/integration-test.js');
check('Integration test binds Prisma to TEST_DATABASE_URL', /process\.env\.DATABASE_URL\s*=\s*process\.env\.TEST_DATABASE_URL/.test(integration));
check('Integration test protects seller write routes from admin', /adminWriteAttempt[\s\S]*status !== 403/.test(integration));

// ---------------------------------------------------------------------------
// Migration-history guard: replays every migration.sql in order and tracks
// which CREATE INDEX ... _trgm_idx indexes are "live" at the end of the
// chain. This is what actually caught the real bug where migration
// 20260917123239_init silently dropped 4 of the 6 trigram search indexes
// created two migrations earlier — a bug that was invisible from reading
// any single migration in isolation, and invisible to `prisma migrate
// deploy`, which reported "no pending migrations" the whole time. Reading
// the migrations in isolation isn't enough; this replays the net effect.
// ---------------------------------------------------------------------------
(() => {
    const migrationsDir = path.join(backend, 'prisma', 'migrations');
    const dirs = fs.readdirSync(migrationsDir).filter(d => fs.statSync(path.join(migrationsDir, d)).isDirectory()).sort();
    const liveIndexes = new Set();
    for (const dir of dirs) {
        const sqlPath = path.join(migrationsDir, dir, 'migration.sql');
        if (!fs.existsSync(sqlPath)) continue;
        const sql = fs.readFileSync(sqlPath, 'utf8');
        for (const m of sql.matchAll(/CREATE\s+INDEX(?:\s+IF NOT EXISTS)?\s+"([^"]+_trgm_idx)"/gi)) liveIndexes.add(m[1]);
        for (const m of sql.matchAll(/DROP\s+INDEX(?:\s+IF EXISTS)?\s+"([^"]+_trgm_idx)"/gi)) liveIndexes.delete(m[1]);
    }
    const expected = [
        'Product_name_trgm_idx', 'Product_description_trgm_idx',
        'Store_name_trgm_idx', 'Store_description_trgm_idx',
        'Store_district_trgm_idx', 'Store_address_trgm_idx'
    ];
    const missing = expected.filter(name => !liveIndexes.has(name));
    check('All 6 trigram search indexes survive the full migration chain (net of every CREATE/DROP)',
        missing.length === 0,
        missing.length ? `Missing after replaying all migrations in order: ${missing.join(', ')}. A migration dropped one of these without a later one recreating it.` : '');
})();

// ---------------------------------------------------------------------------
// Concurrency / production-load hardening (added after a static audit found
// three gaps that only bite under real simultaneous traffic, not local
// single-user testing).
// ---------------------------------------------------------------------------
check('Express trusts exactly one proxy hop (required behind Railway/any LB — otherwise every visitor shares one rate-limit bucket and IP-keyed limiting is broken)',
    /app\.set\(['"]trust proxy['"],\s*1\)/.test(app));
check('Every /api route has a baseline rate limiter, not just auth and public catalog',
    /app\.use\(['"]\/api['"],\s*generalApiLimiter\)/.test(app));
check('Uncaught exceptions trigger a clean drain-and-restart instead of an unhandled crash',
    /process\.on\(['"]uncaughtException['"]/.test(read('nextastore-backend/server.js')));
check('Unhandled promise rejections are logged instead of silently crashing every in-flight request',
    /process\.on\(['"]unhandledRejection['"]/.test(read('nextastore-backend/server.js')));
check('DATABASE_URL pool sizing (connection_limit) is documented for production',
    /connection_limit=/.test(read('nextastore-backend/.env.example')));


const subscription = read('js/subscription.js');
const subscriptionHtml = read('subscription.html');
const mainJs = read('js/main.js');
const subscriptionRoute = read('nextastore-backend/src/routes/subscription.js');
const subscriptionMigration = read('nextastore-backend/prisma/migrations/20260915170000_remove_legacy_subscription_grants/migration.sql');
check('Legacy five-year subscription grants are removed by corrective migration', /subscriptionPaidUntil.*NULL/.test(subscriptionMigration) && /NOT EXISTS/.test(subscriptionMigration) && /approved/.test(subscriptionMigration));
check('Seller badge requires an active 6+ month commitment', /badgeCommitmentMonths.*>= 6/.test(read('nextastore-backend/src/helpers.js')) && /isPaid/.test(read('nextastore-backend/src/helpers.js')));
check('Subscription amount is enforced server-side', /expectedAmount\s*=\s*SUBSCRIPTION_PRICE_UGX\s*\*\s*periodMonths/.test(subscriptionRoute));
check('Subscription page has exact-total UX', /exact total/i.test(subscriptionHtml) && /syncAmount/.test(subscription));
check('Global seller badges render from live store state', /renderSellerBadges/.test(mainJs) && /apiRequest\('\/store'\)/.test(mainJs));
check('Seller ratings are retired from the public store model', (() => { const m = schema.match(/model Store \{[\s\S]*?(?=\nmodel |\nenum )/); return !!m && !/\brating\s+Float\b/.test(m[0]) && !/storesRating/.test(read('stores.html')) && !/store\.rating/.test(read('js/store-detail.js')); })());
check('Product ratings/reviews are fully retired (model, route, schema, UI) — orders happen directly between buyer and seller, so a star rating is not a verifiable trust signal',
  (() => {
    const productDetailJs = read('js/product-detail.js');
    const productDetailHtml = read('product-detail.html');
    return !/model Review \{/.test(schema)
      && !/\brating\s+Float\b/.test(schema) && !/\breviews\s+Int\b/.test(schema)
      && !fs.existsSync(path.join(backend, 'src/routes/reviews.js'))
      && !/reviewRoutes/.test(app) && !/\/api\/reviews/.test(app)
      && !/reviewSchema/.test(validation)
      && !/writeReviewBtn|reviewModal|submitReview|renderRatingBreakdown/.test(productDetailJs)
      && !/reviewModal|ratingInput|writeReviewBtn/.test(productDetailHtml);
  })());
check('Public "completed orders" trust counts are retired — NextaStore only connects buyer and seller, so it cannot vouch that an order was actually fulfilled',
  (() => {
    const storeRoute = read('nextastore-backend/src/routes/store.js');
    const storesJs = read('js/stores.js');
    const storeDetailJs = read('js/store-detail.js');
    return !/completedOrderCount/.test(storeRoute)
      && !/completedOrderCount/.test(storesJs)
      && !/completedOrderCount/.test(storeDetailJs);
  })());
check('Seller order actions are simplified to Confirm / Mark completed / Cancel instead of a free-jump status select, and the backend no longer routes new orders through "shipped"',
  (() => {
    return !/order-status-select/.test(dashboard)
      && /sellerOrderActions/.test(dashboard)
      && /data-order-action/.test(dashboard)
      && /processing:\s*\[\s*'delivered',\s*'cancelled'\s*\]/.test(orderRoutes);
  })());
check('Buyer self-service order cancellation exists: grace-period + reason-picker endpoint, anti-abuse limit, seller notification, and frontend UI',
  (() => {
    const migration = read('nextastore-backend/prisma/migrations/20260922120000_buyer_order_cancellation/migration.sql');
    return /cancelledAt\s+DateTime\?/.test(schema) && /cancelReason\s+String\?/.test(schema)
      && /cancelDetails\s+String\?/.test(schema) && /cancelInitiator\s+String\?/.test(schema)
      && /ADD COLUMN "cancelledAt"/.test(migration)
      && /orderCancelSchema/.test(validation)
      && /router\.post\('\/:id\/cancel'/.test(orderRoutes)
      && /CANCEL_GRACE_PERIOD_MS/.test(orderRoutes) && /CANCEL_ABUSE_LIMIT/.test(orderRoutes)
      && /type:\s*'order_cancelled'/.test(orderRoutes)
      && /canSelfCancel/.test(orders) && /openCancelModal/.test(orders)
      && /orders\/\$\{encodeURIComponent\(o\.id\)\}\/cancel/.test(orders);
  })());

check('Integration test covers Seller Pass approval flow', /subscription\/payments/.test(integration) && /admin\/subscription-payments/.test(integration) && /isPaid/.test(integration));

// --- Login redirect allow-list (js/auth.js) must match the pages that really need a role ---
{
  const authJs = read('js/auth.js');
  const listOf = (name) => {
    const m = authJs.match(new RegExp(`const ${name} = \\[([^\\]]*)\\]`));
    return m ? [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]).sort() : [];
  };
  const pages = fs.readdirSync(root).filter(f => f.endsWith('.html'));
  // auth.js lists clean addresses (/dashboard); the files on disk still end in .html
  const withAttr = (attr) => pages.filter(f => new RegExp(`<body[^>]*\\b${attr}\\b`).test(read(f))).map(f => '/' + f.replace(/\.html$/, '')).sort();
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  check('Login redirect: SELLER_ONLY_PAGES matches every data-seller-required page',
    same(listOf('SELLER_ONLY_PAGES'), withAttr('data-seller-required')),
    `auth.js has [${listOf('SELLER_ONLY_PAGES')}], HTML has [${withAttr('data-seller-required')}]`);
  check('Login redirect: ADMIN_ONLY_PAGES matches every data-admin-required page',
    same(listOf('ADMIN_ONLY_PAGES'), withAttr('data-admin-required')),
    `auth.js has [${listOf('ADMIN_ONLY_PAGES')}], HTML has [${withAttr('data-admin-required')}]`);
  check('Login redirect: AUTH_PAGES covers every data-auth-page page (no redirect loops)',
    withAttr('data-auth-page').every(f => listOf('AUTH_PAGES').includes(f)),
    `data-auth-page pages: [${withAttr('data-auth-page')}]`);
  check('signup.html carries the data-signup-page flag auth.js looks for',
    /<body[^>]*\bdata-signup-page\b/.test(read('signup.html')));
}

// --- Web Push: service worker handlers + every place a session is revoked must also drop push devices ---
{
  const sw = read('service-worker.js');
  const pkg = JSON.parse(fs.readFileSync(path.join(backend, 'package.json'), 'utf8'));
  const authRoute = read('nextastore-backend/src/routes/auth.js');
  const userRoute = read('nextastore-backend/src/routes/user.js');
  const pushRoute = read('nextastore-backend/src/routes/push.js');
  // The source between one route declaration and the next, so a call in some OTHER route can't satisfy the check.
  const routeBody = (src, header) => {
    const start = src.indexOf(header);
    if (start < 0) return '';
    const next = src.indexOf('\nrouter.', start + header.length);
    return src.slice(start, next < 0 ? undefined : next);
  };
  check('Service worker has push, notificationclick and pushsubscriptionchange handlers',
    ['push', 'notificationclick', 'pushsubscriptionchange'].every(e => new RegExp(`addEventListener\\(['"]${e}['"]`).test(sw)));
  check('Service worker cache version is v7 or later (push release must not be served stale)',
    (() => { const m = sw.match(/CACHE_VERSION = 'v(\d+)'/); return !!m && Number(m[1]) >= 7; })());
  check('Push notification badge asset exists and is referenced by the service worker',
    fs.existsSync(path.join(root, 'assets/brand/png/badge/badge-96.png')) && /badge\/badge-96\.png/.test(sw));
  check('Push notifications use a distinct badge per type, all present on disk, with a fallback for unknown types', (() => {
    const types = ['new_message', 'new_order', 'low_stock', 'order_cancelled', 'new_product', 'subscription'];
    const allReferenced = types.every(t => new RegExp(`${t}:\\s*'\\/assets\\/brand\\/png\\/badge\\/${t}\\.png'`).test(sw));
    const allOnDisk = types.every(t => fs.existsSync(path.join(root, `assets/brand/png/badge/${t}.png`)));
    const hasFallback = /pushBadgeFor/.test(sw) && /PUSH_BADGES_BY_TYPE\[type\]\s*\|\|\s*PUSH_BADGE/.test(sw);
    return allReferenced && allOnDisk && hasFallback;
  })());
  check('POST /api/push/test requires a signed-in user', /router\.post\(['"]\/test['"],\s*requireAuth/.test(pushRoute));
  check('logout-everywhere also removes the person\'s push devices',
    /removeAllSubscriptionsForUser\(req\.user\.id\)/.test(routeBody(authRoute, "router.post('/logout-all'")));
  check('password reset also removes the person\'s push devices',
    /removeAllSubscriptionsForUser\(userId\)/.test(routeBody(authRoute, "router.post('/reset-password'")));
  check('password change (PUT /user/me) removes push devices only when the password changed',
    /if \(passwordChanged\) await removeAllSubscriptionsForUser\(req\.user\.id\)/.test(routeBody(userRoute, "router.put('/me'")));
  check('suspending an account removes its push devices',
    /accountStatus === 'suspended'[^\n]*removeAllSubscriptionsForUser\(target\.id\)/.test(adminRoute));
  check('package.json has test:push and test:push-browser scripts',
    !!pkg.scripts && /push-sw-test\.js/.test(pkg.scripts['test:push'] || '') && /push-backend-test\.js/.test(pkg.scripts['test:push'] || '') && /push-sw-browser-test\.js/.test(pkg.scripts['test:push-browser'] || ''));
  check('test:push also runs the page-side (js/push.js) fake-browser suite',
    /push-page-test\.js/.test(pkg.scripts['test:push'] || ''));
}

// --- Web Push, page side (package 2A): js/push.js wiring, the bell's "Turn on" row, and the Settings toggle ---
{
  const pushJs = read('js/push.js');
  const main = read('js/main.js');
  const dashboardJs = dashboard; // already loaded above
  const dashboardHtml = read('dashboard.html');
  const pagesWithBell = ['admin.html', 'cart.html', 'dashboard.html', 'favorites.html', 'following.html',
    'index.html', 'marketplace.html', 'messages.html', 'onboarding.html', 'orders.html',
    'product-detail.html', 'product-form.html', 'store-detail.html', 'stores.html', 'subscription.html'];

  check('js/push.js exposes enable/disable/isSubscribed/serverStatus/sendTest',
    ['enable', 'disable', 'isSubscribed', 'serverStatus', 'sendTest'].every(fn => new RegExp(`${fn}\\s*\\(`).test(pushJs)));
  check('enable() never requests permission except from a direct call (no auto-run on load)',
    !/requestPermission\(\)/.test(pushJs.slice(0, pushJs.indexOf('async enable()'))));
  check('Subscribing sends endpoint + keys.p256dh + keys.auth, matching pushSubscribeSchema',
    /endpoint:\s*json\.endpoint/.test(pushJs) && /p256dh:\s*json\.keys\.p256dh/.test(pushJs) && /auth:\s*json\.keys\.auth/.test(pushJs));
  check('pushsubscriptionchange messages from the service worker are re-registered with the server',
    /ns-push-subscription-changed/.test(pushJs) && /registerSubscription\(data\.subscription\)/.test(pushJs));

  check('Every page with the notification bell also loads js/push.js after js/main.js',
    pagesWithBell.every(f => /<script src="js\/main\.js"><\/script><script src="js\/push\.js"><\/script>/.test(read(f))),
    `missing/misordered on: ${pagesWithBell.filter(f => !/<script src="js\/main\.js"><\/script><script src="js\/push\.js"><\/script>/.test(read(f))).join(', ')}`);

  check('Bell dropdown has a "Turn on push notifications" row',
    /data-notification-push-row/.test(main));
  check('The push row is hidden by default (shown only once real status is known)',
    /notification-preview-push-row hidden/.test(main));
  check('Opening the account nav refreshes the push row via NextaPush, not a guess',
    /refreshPushBellRow\(pushRow\)/.test(main) && /window\.NextaPush\.serverStatus\(\)/.test(main) && /window\.NextaPush\.isSubscribed\(\)/.test(main));

  check('Settings has a push notifications toggle and a Send-a-test button',
    /id="pushToggle"/.test(dashboardHtml) && /id="pushTestBtn"/.test(dashboardHtml));
  check('Settings toggle drives NextaPush.enable()/disable(), not a fake local flag',
    /window\.NextaPush\.enable\(\)/.test(dashboardJs) && /window\.NextaPush\.disable\(\)/.test(dashboardJs));
  check('Settings re-checks real status on every visit to the Notifications tab (loadPushSettings)',
    /loadPushSettings\(\)/.test(dashboardJs) && /this\.loadNotificationPrefs\(\);\s*\n\s*this\.loadPushSettings\(\);/.test(dashboardJs));
  check('A denied browser permission disables the toggle instead of letting it lie',
    /permission === 'denied'/.test(dashboardJs));
}

// --- Web Push, package 2B: soft pre-permission prompt, iOS guidance, consent copy, password-change re-registration ---
{
  const pushJs = read('js/push.js');
  const promptJs = read('js/push-prompt.js');
  const dashboardJs2 = dashboard; // already loaded above
  const pagesWithBell = ['admin.html', 'cart.html', 'dashboard.html', 'favorites.html', 'following.html',
    'index.html', 'marketplace.html', 'messages.html', 'onboarding.html', 'orders.html',
    'product-detail.html', 'product-form.html', 'store-detail.html', 'stores.html', 'subscription.html'];

  check('push-prompt.js never touches the browser permission API directly \u2014 always through NextaPush.enable()',
    !/requestPermission/.test(promptJs) && /window\.NextaPush\.enable\(\)/.test(promptJs));
  check('The prompt is only shown from maybeShow(), never on script load, and is exposed for tests',
    /setTimeout\(function \(\) \{ maybeShow\(\); \}, SHOW_DELAY_MS\)/.test(promptJs) &&
    /_maybeShow:\s*maybeShow/.test(promptJs));
  check('maybeShow() requires a signed-in person before doing anything',
    /if \(typeof app === 'undefined' \|\| !app \|\| !app\.token\) return;/.test(promptJs));
  check('maybeShow() backs off while snoozed and skips a permission already decided',
    /if \(isSnoozed\(\)\) return;/.test(promptJs) && /permission\(\) !== 'default'\) return;/.test(promptJs));
  check('maybeShow() skips a device that is already subscribed or a server that is not configured',
    /if \(already\) return;/.test(promptJs) && /if \(!status\.enabled \|\| !status\.publicKey\) return;/.test(promptJs));

  check('Dismissing snoozes 3 days first, then 14 days on every dismissal after that',
    /FIRST_SNOOZE_DAYS = 3/.test(promptJs) && /LATER_SNOOZE_DAYS = 14/.test(promptJs) &&
    /count <= 1 \? FIRST_SNOOZE_DAYS : LATER_SNOOZE_DAYS/.test(promptJs));
  check('A denied permission is not snoozed \u2014 permission() !== \'default\' already keeps it from showing again',
    /if \(err\.reason !== 'denied'\) snooze\(\);/.test(promptJs));
  check('The banner has consent copy explaining what it is for and that it is reversible in Settings',
    /push-soft-prompt-body/.test(promptJs) && /turn it off anytime in Settings/.test(promptJs));
  check('The banner closes itself if this device gets subscribed through another route while it is open',
    /ns-push-state-changed/.test(promptJs) && /if \(e && e\.detail && e\.detail\.subscribed\) remove\(\);/.test(promptJs));

  check('iPhone guidance only appears when Safari cannot do Web Push outside an installed app',
    /shouldOfferIosGuidance/.test(promptJs) &&
    /isIos\(\) && !isStandalone\(\) && iosCouldSupportPushIfInstalled\(\)/.test(promptJs) &&
    /!\(window\.NextaPush && window\.NextaPush\.supported\(\)\)/.test(promptJs));
  check('iPhone guidance is gated on iOS 16.4+ (Web Push did not exist for installed apps before that)',
    /v !== null && v >= 16\.4/.test(promptJs));
  check('iPhone guidance points at Share \u2192 Add to Home Screen, not a dead end',
    /Add to Home Screen/.test(promptJs));

  check('Every touch target in the prompt (Turn on / Not now / Got it) meets the 44px minimum',
    /\.push-soft-prompt-enable,\.push-soft-prompt-dismiss\{[^}]*min-height:44px/.test(read('css/main.css')));

  check('Every page with the notification bell also loads js/push-prompt.js right after js/push.js',
    pagesWithBell.every(f => /<script src="js\/main\.js"><\/script><script src="js\/push\.js"><\/script><script src="js\/push-prompt\.js"><\/script>/.test(read(f))),
    `missing/misordered on: ${pagesWithBell.filter(f => !/<script src="js\/main\.js"><\/script><script src="js\/push\.js"><\/script><script src="js\/push-prompt\.js"><\/script>/.test(read(f))).join(', ')}`);

  check('js/push.js exposes reregisterAfterCredentialChange() for a silent re-subscribe after a password change',
    /async reregisterAfterCredentialChange\(\)/.test(pushJs) && /await registerSubscription\(sub\)/.test(pushJs.slice(pushJs.indexOf('reregisterAfterCredentialChange'))));
  check('A successful password change re-registers this device\u2019s push subscription under the fresh token',
    /if \(newPassword && window\.NextaPush\) window\.NextaPush\.reregisterAfterCredentialChange\(\);/.test(dashboardJs2));
}

// --- Two-tier notifications (frontend behaviour; see notifications-browser-test.js) ---
{
  const mainJs = read('js/main.js');
  check('Bell tap clears the badge BEFORE the list request, then confirms against the server after acknowledge',
    /applyNotificationCount\(0\);\s*\n\s*const acknowledged = this\.apiRequest\('\/notifications\/acknowledge'/.test(mainJs) && /\.then\(\(\) => this\.refreshNotificationBadge\(\)\)/.test(mainJs));
  check('The batch action is labelled "Mark all as read"', />Mark all as read<\/button>/.test(mainJs));
  check('A notification with no link is still tappable to mark it read (div carries data-notification-id)',
    /<div class="notification-preview-item[^`]*data-notification-id/.test(mainJs) && /closest\('\[data-notification-id\]'\)/.test(mainJs));
}

// --- Mobile drawer / responsive tables (behaviour: mobile-drawer-browser-test.js) ---
{
  const dashCss = read('css/dashboard.css');
  const mobileCss = read('css/mobile.css');
  const dashJs = read('js/dashboard.js');
  const dashHtml = read('dashboard.html');
  check('Drawer uses the dynamic viewport unit and reserves the safe-area inset', /height:\s*100dvh/.test(mobileCss) && /padding-bottom:\s*env\(safe-area-inset-bottom/.test(mobileCss));
  check('Sidebar is pinned with top:0 (a fixed element with no top sat 4px low under the accent bar)', /\.sidebar\s*\{[^}]*position:\s*fixed;[^}]*top:\s*0;/.test(dashCss));
  check('A closed mobile drawer is visibility:hidden (out of the tab order), shown when .open', /\.sidebar\s*\{[^}]*visibility:\s*hidden/.test(dashCss) && /\.sidebar\.open\s*\{[^}]*visibility:\s*visible/.test(dashCss));
  check('The page behind the open drawer is scroll-locked (body.drawer-open)', /body\.drawer-open\s*\{\s*overflow:\s*hidden/.test(dashCss));
  check('One drawer controller: aria-expanded, Escape, Tab trap, focus return, resize-to-wide reset', /setDrawerOpen/.test(dashJs) && /aria-expanded/.test(dashJs) && /'Escape'/.test(dashJs) && /e\.key === 'Tab'/.test(dashJs) && /matchMedia\('\(min-width: 769px\)'\)/.test(dashJs));
  check('Choosing a dashboard section closes the drawer through that same controller', /if \(this\.setDrawerOpen\) this\.setDrawerOpen\(false\)/.test(dashJs));
  check('The hamburger declares aria-controls / aria-expanded and the sidebar has the matching id', /id="menuToggle"[^>]*aria-controls="dashboardSidebar"[^>]*aria-expanded="false"/.test(dashHtml) && /id="dashboardSidebar"/.test(dashHtml));
  check('Under 768px .table rows become card stacks labelled by data-label (the overflow:hidden wrapper used to clip them)', /\.table td::before\s*\{\s*content:\s*attr\(data-label\)/.test(dashCss));
  check('Every cell of the orders table and the top-products table carries a data-label',
    (dashJs.match(/<td data-label="(Order ID|Customer|Total|Fulfillment|Status|Date)"/g) || []).length === 6 && (dashJs.match(/<td data-label="(Product|Category|Price|Sold|Revenue)"/g) || []).length === 5);
  check('Account menu keeps Log out pinned (sticky) so a short screen never hides it', /\.account-menu-logout\s*\{[^}]*position:\s*sticky/.test(mobileCss));
}

// --- Follower notifications on new product ---
{
  const helpersJs = read('nextastore-backend/src/helpers.js');
  const productsRoute = read('nextastore-backend/src/routes/products.js');
  const newProductMigration = read('nextastore-backend/prisma/migrations/20260920090000_new_product_follower_notification/migration.sql');
  const notifyFnBody = helpersJs.slice(helpersJs.indexOf('async function notifyStoreFollowersOfNewProduct'), helpersJs.indexOf('async function getActivePaymentMethods'));

  check('new_product exists in the NotificationType enum', /enum NotificationType\s*\{[^}]*new_product/.test(schema));
  check('The enum value is added by a real migration using valid plain SQL (not double-encoded quotes)',
    /ALTER TYPE \"NotificationType\" ADD VALUE IF NOT EXISTS 'new_product';/.test(newProductMigration) && !/\"'\"'new_product'\"'\"'/.test(newProductMigration));

  check('notifyStoreFollowersOfNewProduct exists and is exported', /async function notifyStoreFollowersOfNewProduct/.test(helpersJs) && /notifyStoreFollowersOfNewProduct,/.test(helpersJs));
  check('It writes one row per follower in a single createMany, not a loop of individual creates',
    /prisma\.notification\.createMany\(/.test(notifyFnBody) && !/for \(.*followers/.test(notifyFnBody));
  check('It excludes the store\u2019s own owner from the follower list',
    /userId:\s*\{\s*not:\s*storeOwnerId\s*\}/.test(notifyFnBody));
  check('It skips writing/pushing entirely when there are no followers',
    /if \(!followers\.length\) return;/.test(notifyFnBody));
  check('It still sends push to every follower, not just the first',
    /Promise\.all\(followers\.map\(f => sendPushToUser\(/.test(notifyFnBody));
  check('Same never-throws contract as the rest of helpers.js: the whole body is wrapped in try/catch',
    /try \{[\s\S]*catch \(err\) \{\s*console\.error/.test(notifyFnBody));

  check('POST /products calls the new helper after creating the product',
    /notifyStoreFollowersOfNewProduct\(\{/.test(productsRoute));
  check('...and does not await it, so a large following can\u2019t slow down the seller\u2019s own response',
    !/await notifyStoreFollowersOfNewProduct/.test(productsRoute));
  check('...called with the fields the notification/link actually need',
    /storeId: store\.id/.test(productsRoute) && /storeName: store\.name/.test(productsRoute) &&
    /storeSlug: store\.slug/.test(productsRoute) && /storeOwnerId: store\.ownerId/.test(productsRoute) &&
    /productId: product\.id/.test(productsRoute) && /productName: product\.name/.test(productsRoute));

  check('The bell has a distinct icon for new_product, not the generic fallback',
    /new_product:\s*'fa-tags'/.test(mainJs));
}

// --- Presence, backend half (round 11 step 3) ---
{
  const presenceRoute = read('nextastore-backend/src/routes/presence.js');
  const serverJs = read('nextastore-backend/server.js');
  const messagesRoute = read('nextastore-backend/src/routes/messages.js');
  const pkg = JSON.parse(read('nextastore-backend/package.json'));
  check('Presence routes are mounted at /api/presence', /app\.use\('\/api\/presence',\s*presenceRoutes\)/.test(app));
  check('The presence stream is authenticated and sent as no-transform (compression() would otherwise buffer it)',
    /router\.post\('\/stream',\s*requireAuth/.test(presenceRoute) && /no-cache, no-transform/.test(presenceRoute));
  check('The presence stream ends on the RESPONSE close event (req close fires after the body is read)',
    /res\.on\('close'/.test(presenceRoute) && !/req\.on\('close'/.test(presenceRoute));
  check('Presence traffic is background traffic for session renewal',
    /BACKGROUND_ANY_METHOD_PATH\s*=\s*\/\^\\\/api\\\/presence/.test(middleware) && /BACKGROUND_ANY_METHOD_PATH\.test\(path\)/.test(middleware));
  check('Shutdown ends presence streams before server.close() waits on them', /const presenceDone = presence\.shutdown\(\)[\s\S]*?server\.close\(async/.test(serverJs));
  check('Logout-everywhere, password reset, password change and suspension all end the person\u2019s presence streams',
    /presence\.disconnectUser/.test(read('nextastore-backend/src/routes/auth.js')) && (read('nextastore-backend/src/routes/auth.js').match(/presence\.disconnectUser/g) || []).length === 2 &&
    /presence\.disconnectUser/.test(read('nextastore-backend/src/routes/user.js')) && /presence\.disconnectUser/.test(adminRoute));
  check('Last-active is written with raw SQL so User.updatedAt is not bumped every few minutes', /\$executeRaw`UPDATE "User" SET "lastActiveAt"/.test(read('nextastore-backend/src/presence.js')));
  check('Conversation list, thread open and since-poll responses all carry the counterpart\u2019s presence',
    /presence: \(other && presenceByUserId/.test(messagesRoute) && (messagesRoute.match(/presence: await threadPresence/g) || []).length === 2);
  check('package.json has a test:presence script', !!pkg.scripts && /presence-test\.js/.test(pkg.scripts['test:presence'] || ''));
}

// --- Presence, frontend half (round 11 step 4) ---
{
  const presenceJs = read('js/presence.js');
  const messagesJs = read('js/messages.js');
  const mainCss = read('css/main.css');
  const messagesCss = read('css/messages.css');
  const storeDetailCss = read('css/store-detail.css');
  const storeDetailHtml = read('store-detail.html');
  const swSource = read('service-worker.js');
  const pushSwTest = read('nextastore-backend/scripts/push-sw-test.js');
  const pushSwBrowserTest = read('nextastore-backend/scripts/push-sw-browser-test.js');

  check('js/presence.js exposes window.NextaPresence with setWatch/seed/render/formatLabel',
    /window\.NextaPresence\s*=\s*\{/.test(presenceJs) && ['setWatch', 'seed', 'render', 'formatLabel'].every(fn => new RegExp(fn).test(presenceJs)));
  check('Presence renders from data-presence-key/-dot/-label attributes rather than held element references',
    /data-presence-key/.test(presenceJs) && /data-presence-dot/.test(presenceJs) && /data-presence-label/.test(presenceJs) &&
    /querySelectorAll\(['"]\[data-presence-key\]['"]\)/.test(presenceJs));
  check('The presence stream carries the Authorization header (EventSource cannot) and is marked background traffic',
    /Authorization.*Bearer \$\{app\.token\}/.test(presenceJs) && /X-Background-Poll/.test(presenceJs));
  check('A stream ends for good on 401/403 or end:replaced, not just retried',
    /res\.status === 401 \|\| res\.status === 403/.test(presenceJs) && /reason === 'replaced'/.test(presenceJs));

  const pagesWithBell = [
    'admin.html', 'cart.html', 'dashboard.html', 'favorites.html', 'following.html',
    'index.html', 'marketplace.html', 'messages.html', 'onboarding.html', 'orders.html',
    'product-detail.html', 'product-form.html', 'store-detail.html', 'stores.html', 'subscription.html'
  ];
  const presenceScriptOrder = /<script src="js\/main\.js"><\/script><script src="js\/push\.js"><\/script><script src="js\/push-prompt\.js"><\/script><script src="js\/ui-overlays\.js"><\/script><script src="js\/presence\.js"><\/script>/;
  check('The auth poll only restarts a server-stopped stream for a NEW token (no 5s re-hammering after 401/replaced/session-ended)',
    /hardStopToken = app\.token/.test(presenceJs) && /stopped && app\.token !== hardStopToken/.test(presenceJs));
  check('presence.js repaints when markup carrying data-presence-key is added (MutationObserver), since pages rebuild it with innerHTML',
    /new MutationObserver/.test(presenceJs) && /addedNodes/.test(presenceJs) && /data-presence-key/.test(presenceJs) && /el\.textContent !== text/.test(presenceJs));
  check('Every page with the notification bell also loads js/presence.js, right after js/ui-overlays.js',
    pagesWithBell.every(f => presenceScriptOrder.test(read(f))),
    `missing/misordered on: ${pagesWithBell.filter(f => !presenceScriptOrder.test(read(f))).join(', ')}`);

  check('Conversation rows carry a presence dot keyed by conversation id',
    /data-presence-key="conversation:\$\{app\.escapeHtml\(c\.id\)\}"[^>]*data-presence-dot/.test(messagesJs));
  check('The thread header seeds and watches the open conversation\u2019s presence',
    /window\.NextaPresence\.seed\(presenceKey, thread\.presence\)/.test(messagesJs) && /data-presence-label/.test(messagesJs));
  // ---- messaging performance: thread cache, peek prefetch, notification dots
  const messagesRouteSrc = read('nextastore-backend/src/routes/messages.js');
  check('GET /conversations/:id/peek is a side-effect-free twin of the thread read that skips marking messages read (a separate path, so an old server 404s instead of marking read)',
    /conversationGetHandler\(true\)/.test(messagesRouteSrc) && /router\.get\('\/conversations\/:id\/peek'/.test(messagesRouteSrc) && /peek \? Promise\.resolve\(\{ count: 0 \}\) : prisma\.message\.updateMany/.test(messagesRouteSrc));
  check('Prefetch (hover / touchstart / focus / bell item) only ever uses the peek form of the thread request',
    /cache\.prefetch\(id, \(\) => this\._fetchThread\(id, \{ peek: true/.test(messagesJs) && /peek \? '\/peek' : ''/.test(messagesJs));
  check('messages.html loads js/thread-cache.js before js/messages.js',
    (() => { const html = read('messages.html'); const a = html.indexOf('js/thread-cache.js'); const b = html.indexOf('js/messages.js'); return a !== -1 && b !== -1 && a < b; })());
  check('Opening a thread no longer waits on the network or the badge refresh before painting and opening the pane',
    (() => { const i = messagesJs.indexOf('async openConversation('); const body = messagesJs.slice(i, messagesJs.indexOf('_cache() {', i));
             return body.indexOf('this.openThreadMobile()') !== -1 && body.indexOf('this.openThreadMobile()') < body.indexOf('await this._fetchThread') && !/await app\.refreshUnreadBadges/.test(body); })());
  check('The composer is never disabled while a message is sending (that closes the phone keyboard)',
    !/input\.disabled = /.test(messagesJs));
  check('Every send has a timeout, so a hung request becomes a failed bubble instead of pending forever',
    (messagesJs.match(/timeoutMs: SEND_TIMEOUT_MS/g) || []).length === 2);
  check('The bell draws an unread dot per unread item, and the dot is styled',
    /notification-unread-dot/.test(mainJs) && /\.notification-unread-dot\{/.test(mainCss));
  check('GET /notifications supports ?unread=1 (newest 30 UNREAD) so unread items past the newest 30 are reachable',
    (() => { const r = read('nextastore-backend/src/routes/notifications.js'); return /req\.query\.unread === '1'/.test(r) && /\.\.\.\(unreadOnly \? \{ readAt: null \} : \{\}\)/.test(r); })());
  check('The bell panel has an All | Unread switch that asks the server for the unread list and resets to All on every open',
    /data-notification-filter=\"unread\"/.test(mainJs) && /'\/notifications\?unread=1'/.test(mainJs)
      && /this\.notificationFilter = 'all';\s*\n\s*this\.notifications\.keepVisible\.clear\(\);/.test(mainJs));
  check('Session end drops the in-memory notification store and thread cache',
    /dropMemoryCaches\(\) \{/.test(mainJs) && /this\.dropMemoryCaches\(\);/.test(mainJs));
  check('A conversation-list load always seeds + (re)watches presence, even on the poll fast-path that skips re-rendering',
    (() => {
        const call = messagesJs.indexOf('this.updatePresenceFromConversations(merged);');
        const fastPathReturn = messagesJs.indexOf('if (preserveLoaded) {');
        return call !== -1 && fastPathReturn !== -1 && call < fastPathReturn;
    })());
  check('updatePresenceFromConversations seeds from each conversation\u2019s own presence field and sets the full watch list',
    /list\.forEach\(c => \{ if \(c\.presence\) window\.NextaPresence\.seed\(`conversation:\$\{c\.id\}`, c\.presence\); \}\)/.test(messagesJs) &&
    /window\.NextaPresence\.setWatch\(list\.map\(c => `conversation:\$\{c\.id\}`\)\)/.test(messagesJs));
  check('The since-poll response\u2019s presence field is applied, not just its messages/readUpdates',
    /presence: threadPresenceData[\s\S]{0,400}window\.NextaPresence\.seed\(`conversation:\$\{id\}`, threadPresenceData\)/.test(messagesJs));

  check('store-detail.js fetches GET /presence/store/:slug and seeds it into a store: watch key',
    /loadSellerPresence\(\)/.test(storeDetail) && /\/presence\/store\/\$\{encodeURIComponent\(this\.store\.slug\)\}/.test(storeDetail) &&
    /window\.NextaPresence\.setWatch\(\[key\]\)/.test(storeDetail));
  check('loadSellerPresence runs after renderStoreInfo, on every store load', /this\.renderStoreInfo\(\);\s*\n\s*this\.loadSellerPresence\(\);/.test(storeDetail));
  check('#storeLogo is wrapped rather than carrying the presence dot as a child (renderStoreInfo replaces its innerHTML/textContent)',
    /class="store-logo-wrap"[\s\S]{0,200}id="storeLogo"[\s\S]{0,200}id="storeSellerPresenceDot"/.test(storeDetailHtml) &&
    /id="storeLogo"><\/div>\s*<span[^>]*id="storeSellerPresenceDot"/.test(storeDetailHtml) &&
    !/logo\.appendChild/.test(storeDetail));

  check('Shared presence styling exists (.presence-dot / .presence-status) with online vs offline colors',
    /\.presence-dot\s*\{/.test(mainCss) && /\.presence-dot\.is-online\s*\{[^}]*var\(--success\)/.test(mainCss) && /\.presence-status\s*\{/.test(mainCss));
  check('Avatars that carry a presence dot are position:relative so it can sit in their corner',
    /\.conversation-item-thumb\s*\{[^}]*position:\s*relative/.test(messagesCss) && /\.thread-header-avatar\s*\{[^}]*position:\s*relative/.test(messagesCss) &&
    /\.store-logo-wrap\s*\{[^}]*position:\s*relative/.test(storeDetailCss));

  check('Service worker cache version was bumped again for the presence frontend release (v8+)',
    (() => { const m = swSource.match(/CACHE_VERSION = 'v(\d+)'/); return !!m && Number(m[1]) >= 8; })());
  check('The push-release cache-version tests derive their expected cache names from CACHE_VERSION dynamically, not hardcoded v6/v7',
    !/nextastore-cache-v6/.test(pushSwTest) && /currentVersionNum/.test(pushSwTest) &&
    !/nextastore-cache-v6/.test(pushSwBrowserTest) && /CURRENT_CACHE_VERSION_NUM/.test(pushSwBrowserTest));
}

// --- Onboarding payment step renders from the payment-method catalog ---
{
  const onboardingJs = read('js/onboarding.js');
  const onboardingHtml = read('onboarding.html');

  check('onboarding.html no longer hardcodes the three MTN/Airtel/card checkboxes',
    !/id="obPayMtn"/.test(onboardingHtml) && !/id="obPayAirtel"/.test(onboardingHtml) && !/id="obPayCard"/.test(onboardingHtml) &&
    /id="obPayList"/.test(onboardingHtml));
  check('Onboarding fetches the platform payment-method catalog and renders step 3 from it',
    /loadPaymentMethods\(\)\s*\{/.test(onboardingJs) && /apiRequest\('\/payments\/methods'\)/.test(onboardingJs) &&
    /renderPaymentOptions\(\)\s*\{/.test(onboardingJs) && /this\.paymentMethods\.map\(/.test(onboardingJs));
  check('Onboarding init() fetches the store and the payment catalog together rather than one blocking the other',
    /Promise\.all\(\[this\.loadExistingStore\(\), this\.loadPaymentMethods\(\), this\.loadProductCount\(\)\]\)/.test(onboardingJs));
  check('An unrecognized payment-method code still renders (falls back to the neutral .ob-pay-icon style, no missing asset/crash)',
    /OB_PAY_BRAND_ICON_CLASS\[m\.code\]\s*\|\|\s*''/.test(onboardingJs));
  check('Review step\u2019s payment chips are built from the fetched catalog, not a hardcoded MTN/Airtel/card list',
    /this\.paymentMethods\s*\n?\s*\.filter\(m => !!this\.store\.payments\?\.\[m\.code\]\)/.test(onboardingJs) &&
    !/this\.store\.payments\.mtnMomo && \{ label: 'MTN MoMo'/.test(onboardingJs));
}

// --- WIP 16 batch 4: auth page redesign, push account name, store-live notification ---
{
  const authCss = read('css/auth.css');
  const pages = ['login.html', 'signup.html', 'forgot-password.html'].map(f => [f, read(f)]);
  check('Login, signup and forgot-password share the awning brand panel and a mobile awning strip',
    pages.every(([, h]) => /class="auth-awning"/.test(h) && /auth-awning auth-awning--mobile/.test(h) && /class="auth-form-main"/.test(h)));
  check('The redesigned auth pages dropped the old breadcrumb bar',
    pages.every(([, h]) => !/page-breadcrumb/.test(h)));
  check('auth.css keeps inputs at 16px on phones (no iOS zoom) and respects reduced motion',
    /font-size: 16px/.test(authCss) && /prefers-reduced-motion: reduce/.test(authCss));
  check('Signup still carries the terms checkbox as required, and Get Started ?type=seller still preselects Sell',
    /id="agreeTerms" required/.test(read('signup.html')) && /get\('type'\) === 'seller'/.test(read('signup.html')));
  check('Signup submit-button label cache is reset when the account type changes',
    /delete btn\.dataset\.originalText/.test(read('signup.html')));

  const pushSrc = read('nextastore-backend/src/push.js');
  const sw = read('service-worker.js');
  check('Push payload carries the recipient account name, looked up in its own never-throws step',
    /accountLabelFor\(userId\)/.test(pushSrc) && /JSON\.stringify\(\{ type, title, body, link, account \}\)/.test(pushSrc) && /catch \(err\) \{\s*return '';/.test(pushSrc));
  check('Service worker prints "Account: <name>" under the message and caps it',
    /Account: \$\{account\}/.test(sw) && /PUSH_ACCOUNT_MAX/.test(sw));

  const schema = read('nextastore-backend/prisma/schema.prisma');
  const storeRoute = read('nextastore-backend/src/routes/store.js');
  check('store_live notification: enum value + migration exist',
    /new_product\s+store_live\s*\}/.test(schema) &&
    /ADD VALUE IF NOT EXISTS 'store_live'/.test(read('nextastore-backend/prisma/migrations/20260924090000_store_live_notification/migration.sql')));
  check('PUT /store notifies the owner only on the draft -> live transition',
    /data\.isPublished === true && !store\.isPublished/.test(storeRoute) && /type: 'store_live'/.test(storeRoute));
  check('Bell maps store_live to an icon', /store_live: 'fa-store'/.test(read('js/main.js')));
}

// --- WIP 16 batch 6: product-form <-> onboarding return flow, server-side launch guard ---
{
  const productFormJs = read('js/product-form.js');
  const storeRoute = read('nextastore-backend/src/routes/store.js');

  check('Product form reads ?from=onboarding and routes its return trip to the review step, not the dashboard',
    /this\.fromOnboarding = this\.params\.get\('from'\) === 'onboarding'/.test(productFormJs) &&
    /this\.returnTo = this\.fromOnboarding \? '\/onboarding\?step=4' : '\/dashboard#products'/.test(productFormJs));
  check('Product form relabels its back link/breadcrumb when arriving from onboarding (no dead-end "Back to Products")',
    /Back to store setup/.test(productFormJs) && /Store setup<\/a>/.test(productFormJs));
  check('The save/delete redirects and the unsaved-changes guard all read the dynamic this.returnTo, not a hardcoded dashboard link',
    (productFormJs.match(/window\.location\.href = this\.returnTo/g) || []).length >= 3);

  check('PUT /store re-checks the product count server-side before allowing the draft -> live transition',
    /data\.isPublished === true && !store\.isPublished\) \{\s*\n\s*const productCount = await prisma\.product\.count\(\{ where: \{ storeId: store\.id, deletedAt: null \} \}\)/.test(storeRoute) &&
    /if \(productCount === 0\) \{\s*\n\s*throw apiError\('Add at least one product before you launch your store\.', 400\)/.test(storeRoute));
  check('The new server-side guard runs before the store update, not after (an already-live store is never re-checked)',
    storeRoute.indexOf('productCount === 0') > 0 &&
    storeRoute.indexOf('productCount === 0') < storeRoute.indexOf('const updated = await prisma.store.update'));

  const dashboardJs = read('js/dashboard.js');
  const dashboardHtml = read('dashboard.html');
  const sw = read('service-worker.js');

  check('Settings\u2019 store-link helpers route through app.storeAddress() instead of reading store.publicUrl directly',
    /publicStoreUrl\(slug\)\s*\{\s*\n\s*return app\.storeAddress\(slug, this\.currentStore\?\.publicUrl\)/.test(dashboardJs) &&
    /renderStoreUrlPrefix\(\)\s*\{[\s\S]{0,200}app\.storeAddress\('', this\.currentStore\?\.publicUrl\)\.prefix/.test(dashboardJs) &&
    !/known\.replace\(\/\\\/s\\\/\[\^\/\]\*\$\//.test(dashboardJs));
  check('viewableStoreUrl (the actual "View store" link) was left alone \u2014 it was already correct',
    /viewableStoreUrl\(slug\)\s*\{\s*\n\s*const clean = encodeURIComponent/.test(dashboardJs));

  check('Dashboard has a dismissible "you\u2019re live" banner, distinct from the draft-notice and setup-nudge banners',
    /id="storeLiveBanner"/.test(dashboardHtml) && /id="storeLiveBannerLink"/.test(dashboardHtml) &&
    /id="dismissLiveBanner"/.test(dashboardHtml) && /id="shareLiveBannerBtn"/.test(dashboardHtml));
  check('renderLiveBanner() is keyed off the one-shot launch flag (not sessionStorage read a second time) and checks store.isPublished as a safety net',
    /renderLiveBanner\(store\)\s*\{/.test(dashboardJs) &&
    /if \(!this\.justLaunched \|\| this\.liveBannerDismissed \|\| !store\.isPublished\)/.test(dashboardJs) &&
    /this\.justLaunched = sessionStorage\.getItem\('nextastore_just_launched'\) === '1'/.test(dashboardJs));
  check('The old one-shot toast on launch was removed in favor of the banner (no longer easy to miss during the redirect)',
    !/Your store is live! Here.s your dashboard\./.test(dashboardJs));
  check('loadStoreBranding() renders the live banner alongside the other store-state banners',
    /this\.renderLiveBanner\(store\);\s*\n\s*this\.renderDraftNotice\(store\);/.test(dashboardJs));

  check('Service-worker cache was bumped again for this batch\u2019s changed dashboard/product-form files',
    (() => { const m = sw.match(/CACHE_VERSION = 'v(\d+)'/); return !!m && Number(m[1]) >= 14; })());
}

// --- WIP 16 batch 8: real ToS/Privacy pages, map modal small-phone fixes ---
{
  const terms = read('terms.html');
  const privacy = read('privacy.html');
  const signup = read('signup.html');
  const picker = read('js/map-picker.js');
  const pickerCss = read('css/map-picker.css');
  const sw = read('service-worker.js');

  check('terms.html and privacy.html exist, are titled, and cross-link to each other',
    /<title>Terms of Service - NextaStore<\/title>/.test(terms) && /<title>Privacy Policy - NextaStore<\/title>/.test(privacy) &&
    /href="\/privacy"/.test(terms) && /href="\/terms"/.test(privacy));
  check('Signup links go to the real pages in a new tab (no more "#"), and the agree checkbox is still required',
    /href="\/terms" target="_blank" rel="noopener">Terms of Service/.test(signup) &&
    /href="\/privacy" target="_blank" rel="noopener">Privacy Policy/.test(signup) &&
    /id="agreeTerms" required/.test(signup) && !/<a href="#">(Terms of Service|Privacy Policy)/.test(signup));
  check('Legal pages state the real product model: no payment processing/escrow, and phone shown only if the seller chooses',
    /does not process your payment/.test(terms) && /only if the seller chooses to show it/.test(privacy) && /only if you choose to show it/.test(terms));
  check('Legal pages use same-site relative canonical URLs',
    /rel="canonical" href="\/terms"/.test(terms) && /rel="canonical" href="\/privacy"/.test(privacy));
  check('Footer/marketplace expose Terms and Privacy; sitemap lists both pages',
    ['index.html', 'dashboard.html', 'store-detail.html', 'marketplace.html'].every(f => /href="\/terms"/.test(read(f)) && /href="\/privacy"/.test(read(f))) &&
    /'\/terms', '\/privacy'/.test(read('nextastore-backend/src/seo.js')));

  check('Map modal close / dismiss / remove-pin buttons use inline SVG (do not depend on the icon-font CDN)',
    /ICON_X/.test(picker) && /ICON_TRASH/.test(picker) &&
    !/mpCloseBtn"[^>]*><i class/.test(picker) && !/mpRemovePinBtn"[^>]*><i class/.test(picker));
  check('Map modal keeps a dropped/dragged pin out from under the floating summary card (panInside)',
    /function keepPinInView\(\)/.test(picker) && /panInside\(/.test(picker) && (picker.match(/keepPinInView\(\);/g) || []).length >= 2);
  check('Map modal selects: short region names, only cities get a suffix, District gets the wider column',
    /<option value="central">Central<\/option>/.test(picker) && !/' \(District\)'/.test(picker) &&
    /\.filter-group:last-child \{ flex: 1\.2 1 0; \}/.test(pickerCss));
  check('Map guidance banner leaves the zoom buttons uncovered; short-height (landscape) rules exist',
    /right: 4rem;/.test(pickerCss) && /right: 3\.75rem;/.test(pickerCss) && /@media \(max-height: 480px\)/.test(pickerCss));
  check('Service-worker cache bumped for this batch',
    (() => { const m = sw.match(/CACHE_VERSION = 'v(\d+)'/); return !!m && Number(m[1]) >= 15; })());
}

// --- WIP 22 (batch 12): fix the Step-1 flash on the way back to Step 4 ---
{
  const onboardingJs = read('js/onboarding.js');
  const onboardingHtml = read('onboarding.html');
  const onboardingCss = read('css/onboarding.css');
  const sw = read('service-worker.js');

  check('Onboarding hides the wizard behind a loading state until the real starting step is known',
    /id="obMain"/.test(onboardingHtml) && /class="ob-main ob-main--loading"/.test(onboardingHtml) &&
    /class="ob-main-loading"/.test(onboardingHtml));
  check('The loading state actually hides the static "Step 1 active" markup, not just an overlay on top of it',
    /\.ob-main--loading \.onboarding-progress,\s*\n\s*\.ob-main--loading \.onboarding-card,\s*\n\s*\.ob-main--loading \.onboarding-actions \{ display: none; \}/.test(onboardingCss));
  check('The wizard is only revealed once this.step has been resolved from ?step=, right before the one and only renderStep() call in init()',
    (() => {
      const initBody = onboardingJs.slice(onboardingJs.indexOf('async init()'), onboardingJs.indexOf('/** Whether a step'));
      const wantedIdx = initBody.indexOf('const wanted =');
      const revealIdx = initBody.indexOf("classList.remove('ob-main--loading')");
      const renderIdx = initBody.indexOf('this.renderStep();');
      return wantedIdx > 0 && revealIdx > wantedIdx && renderIdx > revealIdx &&
        (initBody.match(/this\.renderStep\(\);/g) || []).length === 1;
    })());
  check('Service-worker cache bumped for this batch',
    (() => { const m = sw.match(/CACHE_VERSION = 'v(\d+)'/); return !!m && Number(m[1]) >= 18; })());
}


// --- WIP 25: dynamic storefront host + local slug CSS fix ---
{
  const main = read('js/main.js');
  const storeDetail = read('js/store-detail.js');
  const seoRoute = read('nextastore-backend/src/routes/seo.js');
  const seo = read('nextastore-backend/src/seo.js');
  const launcher = read('start-local.bat');
  const sw = read('service-worker.js');

  check('Store address uses the browser\'s current origin instead of a hardcoded production hostname',
    /window\.location\?\.origin/.test(main) && !/const BRAND_HOST = ['"]nextastores\.com['"]/.test(main));
  check('Store-detail canonical URL follows the current page origin',
    /new URL\(`\/\$\{encodeURIComponent\(this\.store\.slug\)\}`, window\.location\.origin\)/.test(storeDetail));
  check('SEO storefront pages derive their public host from the incoming request and cache per host',
    /function requestSiteUrl\(req\)/.test(seoRoute) && /const cacheKey = `seo:store-page:\$\{siteUrl\}:\$\{slug\}`/.test(seoRoute) && /const key = `seo:sitemap:\$\{siteUrl\}`/.test(seoRoute));
  check('SEO storefront shell no longer injects a deployment-specific base href',
    !/baseHref/.test(seo) && !/<base href/.test(seo));
  check('Local frontend proxy preserves the browser host for dynamic storefront URLs',
    /--proxy-options\.changeOrigin false/.test(launcher) && /--proxy-options\.xfwd true/.test(launcher));
  check('Service worker cache version is bumped for the dynamic-host/storefront fix',
    (() => { const m = sw.match(/CACHE_VERSION = 'v(\d+)'/); return !!m && Number(m[1]) >= 21; })());
}

// --- WIP 26: two-photo proof-scanner extract flow + goal-card mobile squish fix ---
{
  const subscriptionJs = read('js/subscription.js');
  const subscriptionHtmlFull = read('subscription.html');
  const mobileCss = read('css/mobile.css');
  const sw = read('service-worker.js');

  check('Proof scanner supports up to two queued photos before extraction',
    /this\.maxPhotos\s*=\s*2/.test(subscriptionJs));
  check('Extraction is a manual, deferred step (Extract button), not run automatically per photo',
    /proofExtractBtn['"]\)\?\.addEventListener\('click',\s*\(\)\s*=>\s*this\.runExtraction\(\)\)/.test(subscriptionJs) &&
    /status:\s*'pending'/.test(subscriptionJs));
  check('A queued two-photo pair is combined into one result (amount/reference merged across all done photos, not per-photo)',
    /recomputeExtraction\(\)/.test(subscriptionJs) && /for \(const photo of this\.photos\)/.test(subscriptionJs));
  check('Per-photo and aggregate "nothing readable" messaging both exist',
    /Nothing readable found/.test(subscriptionJs) && /couldn't read anything in that photo/.test(subscriptionJs) && /couldn't find an amount or transaction ID/.test(subscriptionJs));
  check('proofExtractBtn and proofEmptyNote exist in the proof modal markup',
    /id="proofExtractBtn"/.test(subscriptionHtmlFull) && /id="proofEmptyNote"/.test(subscriptionHtmlFull));
  check('Goal card wraps instead of squishing on narrow screens',
    /\.subscription-goal-card\{flex-wrap:wrap\}/.test(mobileCss));
  check('Service-worker cache version is bumped for this batch\'s changed precached file (css/mobile.css)',
    (() => { const m = sw.match(/CACHE_VERSION = 'v(\d+)'/); return !!m && Number(m[1]) >= 22; })());
}

// --- WIP 27: "No badge yet" copy, mandatory mobile-money method choice, admin-editable dial instructions ---
{
  const subscriptionJs = read('js/subscription.js');
  const subscriptionHtmlFull = read('subscription.html');
  const subscriptionCss = read('css/subscription.css');
  const adminHtmlFull = read('admin.html');
  const adminJs = read('js/admin.js');
  const platformSettingsMigration = read('nextastore-backend/prisma/migrations/20260927090000_platform_settings_dial_instructions/migration.sql');

  check('Mobile-money method starts unselected so a seller cannot silently default to MTN',
    /<option value="">Choose a payment option<\/option>/.test(subscriptionHtmlFull));
  check('Submitting without choosing a method is its own explained, blocked state',
    /if \(!method\) return app\.showAlert\(/.test(subscriptionJs));
  check('Payment cards show a radio indicator, not only a color/shadow change, when selected',
    /pay-number-radio/.test(subscriptionJs) && /\.pay-number-radio\{/.test(subscriptionCss));
  check('Merchant number is labeled as a destination ("Send to"), not a bare code',
    /<small>Send to<\/small>/.test(subscriptionJs));
  check('Admin-set dial instructions render under the payment cards once a method is chosen',
    /id="subPayDial"/.test(subscriptionHtmlFull) && /renderDialInstructions\(method\)/.test(subscriptionJs) && /renderDialInstructions\(current\)/.test(subscriptionJs));
  check('Dial instructions are carried end-to-end: schema + migration + validation + subscription route',
    /mtnMomoInstructions\s+String\s+@default\(""\)/.test(schema) &&
    /airtelMoneyInstructions\s+String\s+@default\(""\)/.test(schema) &&
    /ADD COLUMN "mtnMomoInstructions"/.test(platformSettingsMigration) &&
    /ADD COLUMN "airtelMoneyInstructions"/.test(platformSettingsMigration) &&
    /mtnMomoInstructions:\s*z\.string\(\)\.trim\(\)\.max\(240\)\.optional\(\)/.test(validation) &&
    /mtnMomoInstructions:\s*settings\.mtnMomoInstructions/.test(subscriptionRoute));
  check('Admin settings form exposes and saves both dial-instruction fields',
    /id="settingsMtnInstructions"/.test(adminHtmlFull) && /id="settingsAirtelInstructions"/.test(adminHtmlFull) &&
    /settingsMtnInstructions['"]\)\.value/.test(adminJs) && /mtnMomoInstructions:document\.getElementById\('settingsMtnInstructions'\)\.value\.trim\(\)/.test(adminJs));
}

// --- WIP 28: badge copy reverted to "No badge", 6mo no longer pre-selected by
// default, dial instructions always render once a method is picked, and a
// [hidden]-vs-author-`display` bug on the dial box is fixed ---
{
  const subscriptionJs = read('js/subscription.js');
  const subscriptionCss = read('css/subscription.css');

  check('Coverage below the first badge threshold reads "No badge", not "No badge yet"',
    /tone-none">No badge</.test(subscriptionJs) && !/No badge yet/.test(subscriptionJs));
  check('A new/expired seller is not pre-steered toward 6 months by default (only an in-progress paid seller gets a recommended month count)',
    /if \(this\.data\?\.isPaid && remaining > 0 && this\.allowedMonths\.includes\(remaining\)\) return remaining;\s*\n\s*return 1;/.test(subscriptionJs));
  check('Dial box has its own [hidden] override so it actually disappears instead of showing an empty strip (same class of bug as .proof-modal-overlay)',
    /\.subscription-pay-dial\[hidden\]\{display:none\}/.test(subscriptionCss));
  check('Dial instructions always render once a network is chosen: a generated fallback (merchant code + live amount) is used whenever no admin text has been set',
    /const fallback = code/.test(subscriptionJs) && /const text = custom \|\| fallback/.test(subscriptionJs));
  check('Dial instructions refresh when the selected coverage/amount changes, not only when the network is (re)selected',
    /const currentMethod = document\.getElementById\('subMethod'\)\?\.value;\s*\n\s*if \(currentMethod\) this\.renderDialInstructions\(currentMethod\);/.test(subscriptionJs));
}

// WIP 29 — storefront polish (store-detail)
{
  const sdHtml = read('store-detail.html');
  const sdCss = read('css/store-detail.css');
  const storeRoute = read('nextastore-backend/src/routes/store.js');
  check('Storefront price filter is a two-thumb slider (range inputs), not number boxes',
    /id="minPrice"[^>]*type="range"|type="range"[^>]*id="minPrice"/.test(sdHtml) && /id="maxPrice"[^>]*type="range"|type="range"[^>]*id="maxPrice"/.test(sdHtml) && !/applyPriceFilter/.test(sdHtml + storeDetail));
  check('GET /store/public returns the store\'s real priceRange (min/max) for the slider ends',
    /priceRange/.test(storeRoute) && /_min: \{ price: true \}/.test(storeRoute) && /priceRange/.test(storeDetail));
  check('Price slider hides itself when every product costs the same (nothing to slide between)',
    /range\.max > range\.min/.test(storeDetail));
  check('Description, directions and category names are clamped / wrapped so long text cannot break the header',
    /store-description-toggle/.test(sdHtml) && /setupDescriptionClamp/.test(storeDetail) && /-webkit-line-clamp: 3/.test(sdCss) && /overflow-wrap: anywhere/.test(sdCss));
  check('Badges overflow into a "+N" chip and are not repeated inside the pill row',
    /seller-badge--more/.test(storeDetail) && !/badgePills/.test(storeDetail));
  check('Active filters show as removable chips with Clear all',
    /data-remove-filter/.test(storeDetail) && /id="activeFilters"/.test(sdHtml));
  check('Mobile filters are a drawer with header, Reset and "Show N results" footer; Escape and overlay close it',
    /sidebar-drawer-foot/.test(sdHtml) && /key === 'Escape'/.test(storeDetail) && /store-drawer-open/.test(storeDetail));
  check('Favorites toggle on the storefront is saved to the API (POST/DELETE), not just a visual flip',
    /method: wasOn \? 'DELETE' : 'POST'/.test(storeDetail));
}

// WIP 30 — store-card badge/name overflow on every surface, presence owner preview, loader grace
{
  const mainJs = read('js/main.js');
  const mainCss = read('css/main.css');
  const presenceRoute = read('nextastore-backend/src/routes/presence.js');
  check('renderSellerBadges has an opt-in "more" chip (+N) that lists the hidden badges in its tooltip',
    /renderSellerBadges\(store, \{[^}]*more = false[^}]*\}/.test(mainJs) && /seller-badge--more/.test(mainJs) && /rest\.map\(b => b\.label\)/.test(mainJs));
  check('Every store card (marketplace, following, home, directory, product mini card) asks for the "+N" chip',
    /limit: 1, more: true/.test(read('js/marketplace.js')) && /limit: 2, more: true/.test(read('js/following.js')) &&
    /limit: 2, more: true/.test(read('index.html')) && /more: true/.test(read('js/stores.js')) && /limit: 2, more: true/.test(read('js/product-detail.js')));
  check('The storefront header does NOT pass "more" (it draws its own chip, so it would show two)',
    !/renderSellerBadges\(this\.store, \{[^}]*more/.test(read('js/store-detail.js')));
  check('A badge can never be wider than its container: labels truncate with an ellipsis (main.css)',
    /\.seller-badge\{max-width:100%;min-width:0/.test(mainCss) && /\.seller-badge>span\{[^}]*text-overflow:ellipsis/.test(mainCss) && /\.seller-badge--more\{/.test(mainCss));
  check('Store names clamp to 2 lines on marketplace/following/home cards and the directory; directory and home descriptions clamp too',
    /\.store-name-text\{[^}]*-webkit-line-clamp:2/.test(read('css/marketplace.css')) && /\.directory-title h2\{[^}]*-webkit-line-clamp:2/.test(read('css/stores.css')) &&
    /\.directory-info p\{[^}]*-webkit-line-clamp:3/.test(read('css/stores.css')) && /\.store-details p \{[^}]*-webkit-line-clamp: 3/.test(read('index.html')));
  check('GET /api/presence/store/:slug lets the store\u2019s owner through (draft/lapsed preview) via optionalAuth; everyone else still needs a published, active store',
    /optionalAuth/.test(presenceRoute) && /isOwner/.test(presenceRoute) && /!isOwner && !isPubliclyVisible\(store\)/.test(presenceRoute));
  check('Storefront follow-state can only hold the page loader for a short grace period (Promise.race), not indefinitely',
    /Promise\.race\(\[followState/.test(storeDetail) && !/Promise\.all\(\[this\.loadFollowState\(\), this\.loadProducts\(\)\]\)/.test(storeDetail));
  check('Service worker cache bumped for the changed main.js / main.css (v23 or later)',
    (() => { const m = read('service-worker.js').match(/CACHE_VERSION = 'v(\d+)'/); return !!m && Number(m[1]) >= 23; })());
}

// WIP 31 — one bulk favorites lookup instead of one request per product card
{
  const favRoute = read('nextastore-backend/src/routes/favorites.js');
  check("GET /favorites/check?ids= exists, is declared before '/:productId', and caps ids at 60",
    /router\.get\('\/check', optionalAuth/.test(favRoute) && favRoute.indexOf("router.get('/check'") < favRoute.indexOf("router.get('/:productId'") && /\.slice\(0, 60\)/.test(favRoute));
  check('The storefront asks /favorites/check once per page and falls back to per-card lookups only if the answer has no list',
    /favorites\/check\?ids=/.test(storeDetail) && /Array\.isArray\(bulk\?\.data\?\.favorited\)/.test(storeDetail));
  check('package.json has a test:favorites-bulk script', /favorites-bulk-test\.js/.test((JSON.parse(read('nextastore-backend/package.json')).scripts || {})['test:favorites-bulk'] || ''));
}

// WIP 36 — product page: enlarge/zoom viewer, stock states, honest delivery & returns copy, related products
{
  const pdJs = read('js/product-detail.js');
  const pdHtml = read('product-detail.html');
  const pdCss = read('css/product-detail.css');
  check('Product page has a full-screen image viewer (dialog markup, open/close, paging, zoom)',
    /id="lightbox"[^>]*role="dialog"[^>]*aria-modal="true"/.test(pdHtml) && /openLightbox\(/.test(pdJs) && /closeLightbox\(/.test(pdJs) && /stepLightbox\(/.test(pdJs) && /zoomAt\(/.test(pdJs));
  check('The viewer answers Escape / arrow keys, traps Tab, and locks page scroll while open',
    /e\.key === 'Escape'/.test(pdJs) && /e\.key === 'ArrowRight'/.test(pdJs) && /e\.key === 'Tab'/.test(pdJs) && /lightbox-open/.test(pdJs) && /html\.lightbox-open[^{]*\{[^}]*overflow:\s*hidden/.test(pdCss));
  check("The browser's Back button closes the viewer instead of leaving the product (pushState + popstate)",
    /history\.pushState\(\{ nxLightbox: 1 \}/.test(pdJs) && /addEventListener\('popstate'/.test(pdJs));
  check('The viewer is above the sticky header and below alerts (z-index 1100; alerts are 5000)',
    /\.lightbox\s*\{[^}]*z-index:\s*1100/.test(pdCss));
  check('Main product photo is shown whole (contain), and gallery thumbnails use the small thumbnails[] variants',
    /\.main-image img\s*\{[^}]*object-fit:\s*contain/.test(pdCss) && /product\?\.thumbnails/.test(pdJs));
  check('Swipe on the main photo pages the gallery and is not also counted as the click that opens the viewer',
    /bindSwipe\(/.test(pdJs) && /_swipeHandled/.test(pdJs));
  check('Out-of-stock products cannot be added, and quantity is capped by stock minus what is already in the cart',
    /Out of stock/.test(pdJs) && /maxQuantity\(\)/.test(pdJs) && /stock - this\.inCartQuantity\(\)/.test(pdJs) && /nextastore:cart-changed/.test(pdJs));
  check('The product page no longer states invented shipping fees, delivery times or a 7-day return policy (NextaStore takes no payment and guarantees no delivery)',
    !/UGX\s*5,000|UGX\s*15,000|Express Shipping|Standard Shipping|Shipping:\s*<strong>Available|within 7 days of delivery|5-7 business days/i.test(pdHtml) && /agreed directly with the seller/.test(pdHtml));
  check('"Related products" is store-scoped: real View all link (no href="#"), section hidden when there is nothing to show',
    !/class="btn-link">View All/.test(pdHtml) && !/href="#" class="btn-link"/.test(pdHtml) && /if \(!this\.store\) \{ if \(section\) section\.hidden = true; return; \}/.test(pdJs) && /if \(!related\.length\) \{ if \(section\) section\.hidden = true; return; \}/.test(pdJs));
  check('Share uses the phone share sheet when available and has a clipboard fallback',
    /navigator\.share/.test(pdJs) && /copyToClipboard\(/.test(pdJs) && /execCommand\('copy'\)/.test(pdJs));
  check('Product-detail browser test is wired into package.json and the service worker cache is v26 or later',
    /product-detail-browser-test\.js/.test((JSON.parse(read('nextastore-backend/package.json')).scripts || {})['test:product-detail-browser'] || '')
    && (() => { const m = read('service-worker.js').match(/CACHE_VERSION = 'v(\d+)'/); return !!m && Number(m[1]) >= 26; })());
}

// --- WIP 38: Overview store-info header holds long content (behaviour: dashboard-overview-browser-test.js) ---
{
  const dashHtml = read('dashboard.html');
  const dashCss = read('css/dashboard.css');
  check('Overview: description is clamped to 3 lines with a Read more toggle, long text wraps instead of running off the card',
    /id="storeDescToggle"[^>]*aria-expanded="false"/.test(dashHtml)
    && /\.store-description\s*\{[^}]*-webkit-line-clamp:\s*3/.test(dashCss)
    && /\.store-info\s*\{[^}]*min-width:\s*0/.test(dashCss)
    && /overflow-wrap:\s*anywhere/.test(dashCss));
  check('Overview: a long address is clamped to 2 lines with a Show full address toggle (phones have no tooltips), and a divider keeps the address Edit apart from the stats',
    /id="storeLocToggle"[^>]*aria-expanded="false"/.test(dashHtml)
    && /#locationText\s*\{[^}]*-webkit-line-clamp:\s*2/.test(dashCss)
    && /#locationText\.is-expanded/.test(dashCss)
    && /syncLocationToggle/.test(dashboard) && /storeLocToggle/.test(dashboard)
    && /\.store-stats-mini\s*\{[^}]*border-left:\s*1px solid/.test(dashCss));
  check('Overview: payment methods fold after 4 behind a "+N more" control, hidden badges get a "+N" chip, edit buttons are labelled',
    /PAYMENT_CHIP_LIMIT|const LIMIT = 4/.test(dashboard) && /storePaymentsToggle/.test(dashboard)
    && /renderSellerBadges\(store, \{ limit: 3, more: true \}\)/.test(dashboard)
    && /aria-label="Edit store details"/.test(dashHtml) && /aria-label="Edit store location"/.test(dashHtml));
  check('Overview: phone layout stretches the header children (flex-start let long text run past the card edge and get clipped)',
    /@media \(max-width: 768px\)[\s\S]*?\.store-header\s*\{[^}]*align-items:\s*stretch/.test(dashCss));
  check('Overview browser test is wired into package.json and the service worker cache is v28 or later',
    /dashboard-overview-browser-test\.js/.test((JSON.parse(read('nextastore-backend/package.json')).scripts || {})['test:dashboard-overview-browser'] || '')
    && (() => { const m = read('service-worker.js').match(/CACHE_VERSION = 'v(\d+)'/); return !!m && Number(m[1]) >= 28; })());
}


// ---- WIP 40: full notification text, no native popups, smart Back ----
{
  const mainJs = read('js/main.js'), mainCss = read('css/main.css'), backNav = read('js/back-nav.js');
  const siteJs = ['js/dashboard.js', 'js/orders.js', 'js/admin.js', 'js/cart-page.js', 'js/store-detail.js', 'js/product-detail.js', 'js/messages.js', 'js/marketplace.js']
    .map(f => read(f)).join('\n');
  check('Notifications: desktop shows the full title and body (no nowrap / ellipsis on the item text)',
    !/\.notification-preview-main (?:strong|span)\{[^}]*(?:white-space:nowrap|text-overflow:ellipsis)/.test(mainCss));
  check('No native browser popups: window.alert / confirm / prompt are not used anywhere in the site scripts',
    !/(?:^|[^A-Za-z0-9_.$])window\.(?:alert|confirm|prompt)\s*\(/m.test(siteJs + read('js/admin.js')) && !/(?<![A-Za-z0-9_.$])(?:alert|prompt)\s*\(/.test(siteJs.replace(/showAlert\(/g, '')));
  check('app.prompt() exists beside app.confirm(), validates inline, and keeps typed text when the backdrop is clicked',
    /\n    prompt\(\{/.test(mainJs) && /site-dialog-error/.test(mainJs) && /_downOnBackdrop/.test(mainJs) && /\.site-dialog-form/.test(mainCss));
  check('Back: js/back-nav.js exists and every page with a back control loads it',
    ['cart', 'favorites', 'following', 'orders', 'store-detail', 'product-detail', 'safety'].every(p => /back-nav\.js/.test(read(`${p}.html`))));
  check('Back: no page hard-wires "Back to marketplace" any more (data-back-link with a fallback instead)',
    ['cart', 'favorites', 'following', 'orders', 'store-detail', 'product-detail', 'safety'].every(p => /data-back-link/.test(read(`${p}.html`)))
    && /data-back-link/.test(storeDetail) && !/closed-screen-back"><i/.test(storeDetail));
  check('Back: the product page falls back to its store (a bare shared link has no earlier page)',
    /backFallbackLabel = 'Back to store'/.test(read('js/product-detail.js')) && /history\.back\(\)/.test(backNav));
  check('Dialogs/Back browser test is wired into package.json and the service worker cache is v30 or later',
    /dialogs-back-browser-test\.js/.test((JSON.parse(read('nextastore-backend/package.json')).scripts || {})['test:dialogs-back-browser'] || '')
    && (() => { const m = read('service-worker.js').match(/CACHE_VERSION = 'v(\d+)'/); return !!m && Number(m[1]) >= 30; })());
}

// ---- WIP 41: badge wording ("24+ months on NextaStore. Confirmed by us, not self-declared.") ----
{
  const helpersSrc = read('nextastore-backend/src/helpers.js'), detailSrc = read('js/store-detail.js');
  check('Badge wording: each tier\'s reason lives once on TIER_PERKS (6+/12+/24+ months on NextaStore) and the six duplicated literals are gone',
    /verified: \{\s*rank: 1,\s*reason: '6\+ months on NextaStore'/.test(helpersSrc)
    && /gold: \{\s*rank: 2,\s*reason: '12\+ months on NextaStore'/.test(helpersSrc)
    && /platinum: \{\s*rank: 3,\s*reason: '24\+ months on NextaStore'/.test(helpersSrc)
    && !/reason: '(?:6|12|24)\+ months?(?: of active paid coverage| confirmed commitment)'/.test(helpersSrc));
  check('Badge wording: the buyer-facing trust card reads "<reason>. Confirmed by us, not self-declared." and the old sentence is gone',
    /\}\. Confirmed by us, not self-declared\.`/.test(detailSrc) && !/earned from confirmed paid time/.test(detailSrc));
  check('Badge wording: badge copy makes no "guaranteed" / "secured" claim (badges are not a guarantee of quality, delivery or a sale)',
    !/reason: '[^']*(?:guarantee|secured)/i.test(helpersSrc) && !/Confirmed by us[^`]*(?:guarantee|secured)/i.test(detailSrc));
  check('Badge wording: service worker cache is v31 or later so returning visitors get the new copy',
    (() => { const m = read('service-worker.js').match(/CACHE_VERSION = 'v(\d+)'/); return !!m && Number(m[1]) >= 31; })());
}

// ---- WIP 42 + 43: a product's own address, which previews properly in WhatsApp ----
{
  const seoRoute = read('nextastore-backend/src/routes/seo.js'), seoSrc = read('nextastore-backend/src/seo.js');
  const appSrc = read('nextastore-backend/src/app.js'), detailJs = read('js/product-detail.js');
  const mainJs = read('js/main.js'), authJs = read('js/auth.js'), slugSrc = read('nextastore-backend/src/slugs.js');
  const pkg = JSON.parse(read('nextastore-backend/package.json')).scripts || {};
  const idx = k => seoRoute.indexOf(`router.get('${k}'`);
  check('Product address: GET /:storeSlug/:productSlug and GET /p/:productId exist and are both registered before the /:slug catch-all',
    idx('/:storeSlug/:productSlug') > -1 && idx('/p/:productId') > -1 && idx('/:storeSlug/:productSlug') < idx('/:slug') && idx('/p/:productId') < idx('/:slug'));
  check('Product address: it serves the REAL product page (renderProductShell on product-detail.html) - never a redirect page with a meta refresh or script redirect',
    /renderProductShell\(shell/.test(seoRoute) && /loadProductShell/.test(read('nextastore-backend/src/storeShell.js')) && /product-detail\.html/.test(read('nextastore-backend/src/storeShell.js'))
    && !/http-equiv="refresh"/i.test(seoSrc) && !/location\.replace\(/.test(seoSrc));
  check('Product address: the page\'s relative CSS / JS / image paths are made root-relative (it lives one folder deeper than the other pages)',
    /function rootRelative\(/.test(seoSrc) && /return rootRelative\(/.test(seoSrc));
  check('Product address: the preview photo is the cover thumbnail first (small JPEG WhatsApp always shows), then the full photo, store logo, brand card',
    /first\(product\.thumbnails\), first\(product\.images\), product\.image, store && store\.logo/.test(seoSrc) && /DEFAULT_OG_IMAGE_PATH/.test(seoSrc));
  check('Product address: a draft / lapsed / deleted-store / unknown product gets generic tags only (live check on the STORE, not the product alone)',
    (() => { const handler = seoRoute.slice(idx('/:storeSlug/:productSlug'), idx('/:slug')); // the product handler only: the store route has the same line
      return /const live = store\.isPublished && isStoreCurrentlyActive\(store\)/.test(handler) && /store\.deletedAt/.test(handler) && /noindex,nofollow/.test(seoSrc); })());
  check('Product address: found by the id\'s tail INSIDE the named store (indexed store filter, case-insensitive), never a table-wide scan',
    /id: \{ endsWith: key, mode: 'insensitive' \}/.test(seoRoute) && /store: \{ deletedAt: null, OR: \[\{ slug: storeKey \}, \{ id: rawStore \}\] \}/.test(seoRoute));
  check('Product address: one address per product - any other spelling 301s to it, and the reserved first words (css, api, errors...) are never shadowed',
    /req\.path !== clean/.test(seoRoute) && /isReservedSlug\(storeKey\)\) return next\(\)/.test(seoRoute) && /RESERVED_SLUGS[\s\S]*'p'/.test(slugSrc));
  check('Product address: both routes are under the public per-IP rate limiter (unauthenticated, read the database)',
    /app\.use\(\['\/s', '\/p', '\/sitemap\.xml', '\/robots\.txt'\], publicCatalogLimiter\)/.test(appSrc) && /\\\/\[A-Za-z0-9-\]\+\(\?:\\\/\[A-Za-z0-9-\]\+\)\?\\\/\?\$\/\.test\(req\.path\)/.test(appSrc));
  check('Product address: the product page reads its product from the server\'s <meta> tags (the address only has a short key), the old ?id= form as fallback, and tidies the address bar',
    /readRoute\(\)/.test(detailJs) && /nx-product-id/.test(detailJs) && /nx-store-slug/.test(detailJs) && /cleanAddress\(\)/.test(detailJs) && /history\.replaceState/.test(detailJs));
  check('Product address: every Share action hands out the product\'s own address (app.productLink), not whatever is in the address bar',
    /shareUrl\(\) \{[\s\S]*?app\.productLink\(this\.product, this\.store\?\.slug\)/.test(detailJs) && /url: this\.shareUrl\(\)/.test(detailJs) && /handleShare\(platform\) \{\s*const url = this\.shareUrl\(\);/.test(detailJs));
  // No page may go back to building the old /product-detail?id=... link by hand: one builder, one address.
  const codeOnly = src => src.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  const handBuilt = fs.readdirSync(path.join(root, 'js')).filter(f => f.endsWith('.js') && /product-detail\?/.test(codeOnly(read(`js/${f}`))));
  check('Product address: no script builds /product-detail?id=... by hand any more (everything goes through app.productLink)', handBuilt.length === 0, handBuilt.join(', '));
  const backendLegacy = ['helpers.js', 'seo.js', 'routes/seo.js', 'routes/products.js', 'routes/messages.js', 'routes/store.js'].filter(f => fs.existsSync(path.join(root, 'nextastore-backend/src', f)) && /product-detail\?id=\$\{(?!encodeURIComponent\(id\))/.test(codeOnly(read(`nextastore-backend/src/${f}`))));
  check('Product address: the backend builds product links with productPath() too (notifications, JSON-LD), the static page only as the no-slug fallback',
    backendLegacy.length === 0 && /productPath\(\{ id: productId, name: productName \}, storeSlug\)/.test(read('nextastore-backend/src/helpers.js')), backendLegacy.join(', '));
  check('Product address: logging in from a product page returns to it (main.js keeps both parts; auth.js accepts exactly that shape and checks the page rules on the FIRST part)',
    /isProductAddress/.test(mainJs) && /\(\?:\\\/\[A-Za-z0-9-\]\+\)\?/.test(authJs) && /split\('\/'\)\[0\]/.test(authJs));
  check('Product address: the browser\'s copy of the address builder is marked in main.js and the parity test is wired in, with the route and browser tests and the service worker cache at v33 or later',
    /nx:product-url:start/.test(mainJs) && /product-url-test\.js/.test(pkg['test:product-url'] || '') && /product-share-test\.js/.test(pkg['test:product-share'] || '') && /product-address-browser-test\.js/.test(pkg['test:product-address-browser'] || '')
    && (() => { const m = read('service-worker.js').match(/CACHE_VERSION = 'v(\d+)'/); return !!m && Number(m[1]) >= 33; })());

  // ---- WIP 50: marketplace rebuild ----
  {
    const mkJs = read('js/marketplace.js'), mkCss = read('css/marketplace.css'), mkHtml = read('marketplace.html'), storesJs = read('js/stores.js');
    check('Marketplace: store and product cards are real links (stretched <a>), images are lazy <img> with a data-fallback, and no card builds a CSS background-image from raw data',
      /class="mk-store-link" href=/.test(mkJs) && /<article class="mk-product/.test(mkJs) && /class="mk-product-link" href=/.test(mkJs) && /loading="lazy"/.test(mkJs) && /data-fallback="product"/.test(mkJs) && !/background-image:url/.test(mkJs) && !/role="button"/.test(mkJs));
    check('Marketplace: 2 store cards per row on phones and 3 / 4 / 5 on wider screens, products 2 / 3 / 4 / 6; page sizes are paired with the columns so the last row is full',
      /\.mk-stores-grid,\s*\.mk-products-grid \{[^}]*repeat\(2, minmax\(0, 1fr\)\)/.test(mkCss) && /repeat\(5, minmax\(0, 1fr\)\)/.test(mkCss) && /repeat\(6, minmax\(0, 1fr\)\)/.test(mkCss) &&
      /storePageSize = vw >= 1280 \? 15/.test(mkJs) && /productPageSize = vw >= 1280 \? 18/.test(mkJs));
    check('Marketplace: Featured stores links to /stores (header link + "View all N stores"), carrying the current search/category, and /stores opens already filtered from ?q= / ?category=',
      /id="viewAllStoresLink"/.test(mkHtml) && /id="storesViewAll"/.test(mkHtml) && /storesDirectoryHref\(\)/.test(mkJs) && /applyUrlFilters/.test(storesJs));
    check('Marketplace: hero numbers come from the API totals (no fixed "500+ / 10K+ / 24/7" claims), a failed request says so with a retry instead of "coming soon", products page with "Show more"',
      !/500\+|10K\+|24\/7/.test(mkHtml) && /updateHeroStats/.test(mkJs) && /data-mk-action="\$\{esc\(action\.action\)\}"/.test(mkJs) && !/<h3>[^<]*[Cc]oming [Ss]oon/.test(mkJs) && /loadMoreProducts/.test(mkJs) && /Intl\.NumberFormat\('en', \{ notation: 'compact'/.test(mkJs));
    check('Marketplace hero v3: market-stall store cards from the stores API, Nexi chat in place of the hero search, stats band, motion respects prefers-reduced-motion',
      /id="heroCollage"/.test(mkHtml) && /id="heroChat"/.test(mkHtml) && !/id="heroSearchForm"/.test(mkHtml) && !/hero-chips/.test(mkHtml) && /renderHeroStores/.test(mkJs) && !/renderHeroCollage/.test(mkJs) && /mountHero/.test(mkJs) && /class="hero-band"/.test(mkHtml) &&
      /\.hero-stall-awning/.test(mkCss) && !/\.hero-tile/.test(mkCss) &&
      /@media \(prefers-reduced-motion: no-preference\)[^@]*hero-content/.test(mkCss.replace(/\n/g, ' ')) && !/rotate\(-1\.1deg\)/.test(mkCss));
    const nexiJs = read('js/assistant.js'), nexiCss = read('css/assistant.css');
    check('Nexi: dock (assistant button + back-to-top), hero chat, safe rendering (no innerHTML of model text), reduced-motion + print rules',
      /window\.NexiAssistant = \{/.test(nexiJs) && /nexi-top/.test(nexiJs) && /mountHero/.test(nexiJs) && /ALLOWED_PATHS/.test(nexiJs) && !/innerHTML\s*=\s*(m|msg|text|ev|reply)\b/.test(nexiJs) &&
      /prefers-reduced-motion: reduce/.test(nexiCss) && /@media print/.test(nexiCss) && /\.nexi-fab/.test(nexiCss) && /z-index: 900/.test(nexiCss));
    const mainJs = read('js/main.js');
    check('Nexi loads on every main.js page via one loader, and admin + inbox opt out',
      /loadAssistantDock/.test(mainJs) && /data-assistant="off"/.test(read('admin.html')) && /data-assistant="off"/.test(read('messages.html')) && /assistant\.js/.test(read('safety.html')));
    const proxyJs = read('nextastore-backend/src/assistantProxy.js');
    check('Nexi proxy: mounted behind its own per-minute and per-hour limits, strips client roles, never buffers the stream',
      /api\/assistant\/chat', assistantMinuteLimiter, assistantHourLimiter/.test(app) && /app\.use\('\/api\/assistant', assistantRoutes\)/.test(app) && /role === 'user' \|\| m\.role === 'assistant'/.test(proxyJs) && /no-transform/.test(proxyJs));
    const svcPrompt = read('ai-assistant/src/chat/sanitize.js');
    check('Nexi service: client history is sanitised (system role dropped), detector matches whole words only',
      /m\.role === 'user' \|\| m\.role === 'assistant'/.test(svcPrompt) && /match\(\/\[a-z/.test(read('ai-assistant/src/lang/detect.js')));
    check('Nexi (WIP 55): panel sits above the site header (z-index > 1000) with one scrolling body + pinned composer, phones/short windows get the sheet, starters are one swipeable row on phones (WIP 56), flagged messages are tagged, service worker at v45 or later',
      (() => { const z = /\.nexi-panel \{[^}]*?z-index:\s*(\d+)/.exec(nexiCss); return !!z && Number(z[1]) > 1000 && Number(z[1]) < 1500; })() &&
      /\.nexi-panel-body/.test(nexiCss) && /\.nexi-panel-bottom/.test(nexiCss) && /max-width: 600px\), \(max-height: 520px\)/.test(nexiCss) && /visualViewport/.test(nexiJs) &&
      /nexi-starters-row/.test(nexiCss) && /scroll-snap-type/.test(nexiCss) && !/nexi-more|nexi-chip--extra/.test(nexiCss) && /nexi-flagtag/.test(nexiCss) && /applyFlag/.test(nexiJs) &&
      (() => { const m = read('service-worker.js').match(/CACHE_VERSION = 'v(\d+)'/); return !!m && Number(m[1]) >= 45; })());
    check('Nexi service (WIP 55): every message is checked for relevance before the model runs (off-topic / inappropriate / private details / manipulation / unclear), curated replies, [OFF_TOPIC] marker is stripped, flag log never stores private details',
      /analyseTurn/.test(read('ai-assistant/src/chat/pipeline.js')) && /markerGate/.test(read('ai-assistant/src/chat/pipeline.js')) && /\[OFF_TOPIC\]/.test(read('ai-assistant/src/chat/systemPrompt.js')) &&
      /\[not stored\]/.test(read('ai-assistant/src/chat/flagLog.js')) && /export-flags/.test(read('ai-assistant/package.json')));
    check('Marketplace v3: product sort + price range (server-side, products only), removable filter chips, favorite hearts via /favorites/check, keyboard-navigable search suggestions',
      /productQuery\(/.test(mkJs) && /id="productsSort"/.test(mkHtml) && /id="priceForm"/.test(mkHtml) && /renderActiveFilters/.test(mkJs) &&
      /\/favorites\/check\?ids=/.test(mkJs) && /class="mk-fav"/.test(mkJs) && /aria-activedescendant/.test(mkJs) && /role="combobox"/.test(mkHtml) && /name="description"/.test(mkHtml));
    check('Marketplace: the real-page browser test is wired in and the service worker cache is at v41 or later',
      /marketplace-browser-test\.js/.test(pkg['test:marketplace-browser'] || '') && (() => { const m = read('service-worker.js').match(/CACHE_VERSION = 'v(\d+)'/); return !!m && Number(m[1]) >= 41; })());
  }

  // ---- WIP 56: starter questions by screen, footer back-to-top removed, All stores directory v2 ----
  {
    const nexiCss56 = read('css/assistant.css'), nexiJs56 = read('js/assistant.js');
    const stCss = read('css/stores.css'), stJs = read('js/stores.js'), stHtml = read('stores.html'), storeRoute = read('nextastore-backend/src/routes/store.js');
    check('WIP 56: footer "Back to top" link is gone (the dock arrow is the only one)',
      !/footer-top-link|footerTopLink/.test(read('marketplace.html') + read('js/marketplace.js') + read('css/marketplace.css')));
    check('WIP 56: Nexi starters are one swipeable row on phones (hero + sheet) and a grid / list on desktop; no "More questions" toggle',
      /nexi-starters-row/.test(nexiJs56) && !/nexi-more|nexi-chip--extra/.test(nexiJs56 + nexiCss56) && /scroll-snap-type: x proximity/.test(nexiCss56) && /repeat\(2, minmax\(0, 1fr\)\)/.test(nexiCss56));
    check('WIP 56: All stores — two cards per row on phones, 3 / 4 on wider screens, 24 per page (fills 2, 3 and 4 columns)',
      /\.stores-directory-grid\{[^}]*repeat\(2,minmax\(0,1fr\)\)/.test(stCss) && /repeat\(3,minmax\(0,1fr\)\)/.test(stCss) && /repeat\(4,minmax\(0,1fr\)\)/.test(stCss) && /STORES_PAGE_SIZE = 24/.test(stJs));
    check('WIP 56: All stores — scales: numbered pagination with a window + go-to-page, URL state, newest-response-wins loading, lazy images, sort + badged filter in the API',
      /pageWindow\(/.test(stJs) && /pg-jump/.test(stJs) && /pushState/.test(stJs) && /seq !== this\.seq/.test(stJs) && /loading="lazy"/.test(stJs) &&
      /id="storesSort"/.test(stHtml) && /id="storesPager"/.test(stHtml) && /DIRECTORY_SORTS/.test(storeRoute) && /badged/.test(storeRoute) && /\{ id: 'asc' \}/.test(storeRoute) &&
      /Store_isPublished_verified_createdAt_idx/.test(read('nextastore-backend/prisma/migrations/20261004090000_store_directory_indexes/migration.sql')));
    check('WIP 56: service worker cache is at v46 or later',
      (() => { const m = read('service-worker.js').match(/CACHE_VERSION = 'v(\d+)'/); return !!m && Number(m[1]) >= 46; })());
  }
}

let failed = 0;
for (const c of checks) {
  console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok || !c.detail ? '' : ` — ${c.detail}`}`);
  if (!c.ok) failed++;
}
console.log(`\n${checks.length - failed}/${checks.length} static checks passed.`);
process.exitCode = failed ? 1 : 0;
