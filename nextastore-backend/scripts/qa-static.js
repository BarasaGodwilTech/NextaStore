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
check('Checkout links to Trust & Safety', /safety\.html/.test(cartPage));
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

check('Integration test covers Seller Pass approval flow', /subscription\/payments/.test(integration) && /admin\/subscription-payments/.test(integration) && /isPaid/.test(integration));

// --- Login redirect allow-list (js/auth.js) must match the pages that really need a role ---
{
  const authJs = read('js/auth.js');
  const listOf = (name) => {
    const m = authJs.match(new RegExp(`const ${name} = \\[([^\\]]*)\\]`));
    return m ? [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]).sort() : [];
  };
  const pages = fs.readdirSync(root).filter(f => f.endsWith('.html'));
  const withAttr = (attr) => pages.filter(f => new RegExp(`<body[^>]*\\b${attr}\\b`).test(read(f))).sort();
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

let failed = 0;
for (const c of checks) {
  console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok || !c.detail ? '' : ` — ${c.detail}`}`);
  if (!c.ok) failed++;
}
console.log(`\n${checks.length - failed}/${checks.length} static checks passed.`);
process.exitCode = failed ? 1 : 0;
