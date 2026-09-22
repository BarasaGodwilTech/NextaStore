# NextaStore Launch Design Pass

## Completed
- Replaced the old marigold/Fraunces/Inter design tokens with the NextaStore brand green, ink green, store green, gold notification accent, and Poppins typography.
- Self-hosted Poppins Regular/Bold from the supplied brand kit.
- Added favicon variants and site-wide Open Graph/Twitter preview image metadata.
- Integrated supplied NextaStore lockup assets into headers and dark/light contexts.
- Consolidated the Message Seller modal into `js/main.js` + `css/main.css`; product-detail and store-detail now use the shared builder.
- Removed the public demo credentials from login.
- Removed non-functional Google/Facebook sign-in buttons from login and signup, including their dead JS handler.
- Added a shared header Messages icon with the existing unread-count endpoint/source of truth and a five-conversation inline preview.
- Added the shared account/messages navigation to the seller dashboard and other utility headers where appropriate.
- Standardized common CTA casing such as `Create account` and `Send message`.
- Removed the duplicated Message Seller modal CSS from `store-detail.css`.
- Kept `store.html` as an intentional compatibility redirect to `store-detail.html` and marked it `noindex`.
- Updated onboarding/dashboard theme examples and dashboard chart colors to the brand palette.
- Removed the uploaded backend `.env` containing development credentials from the launch archive; `.env.example` remains.

## Verification
- JavaScript syntax checks passed for modified JS files.
- Existing backend static QA passed: 23/23 checks.
- Local asset paths used by the brand integration are included in the archive.


# Round 10 — Bug Fixes + Redesign Pass

## Phase 1 — Critical bugs
- `css/main.css`: consolidated `.btn-primary` and `.btn-outline` so each has one canonical definition; retained dark-surface contrast in scoped hero/promotion selectors.
- `index.html`: corrected the header lockup to the color asset on the cream navbar and removed duplicate inline outline-button styling.
- Verification: selector-count/static checks performed after edits; modified JS syntax checked below.

## Phase 2 — Trust & Safety
- `js/cart-page.js`: added a checkout trust strip linking to `safety.html` and using the policy's actual guidance about keeping communication in NextaStore messaging.
- `js/main.js`: added the same trust reminder to the shared Message Seller modal.
- `js/store-detail.js`, `css/store-detail.css`: surfaced the backend-supported `verified` flag as a dynamic “Verified seller” badge and used existing store color data for accents.
- Verification: backend schema/routes inspected; no backend changes made.

## Phase 3 — Cart redesign
- `css/cart.css`: redesigned the heading treatment, store groups, checkout card, empty state, and success state while retaining existing cart hooks and data flow.
- Verification: `cart-page.js` data flow left intact; JS syntax/static QA executed in final QA pass.

## Phase 4 — Messages redesign
- `css/messages.css`: redesigned conversation hierarchy, unread treatment, empty states, thread bubbles, and composer; kept `messages.js` data flow unchanged and preserved the 720px responsive collapse.
- Verification: `messages.js` not modified; JS syntax/static QA executed in final QA pass.

## Phase 5 — Storefront variety
- `js/store-detail.js`: applies the store's existing banner/accent color data to `--store-accent` and uses the existing backend `verified` field.
- `css/store-detail.css`: extends store accent into actions, section underlines, category state, and empty states; increased store identity presence.
- Verification: Prisma schema and store routes confirm `verified` is backend-supported; no new fields added.

## Phase 6 — Sitewide consistency
- Shared button/state/trust treatments remain in `main.css`; cart/messages/store pages consume the same brand tokens and Poppins typography.
- Verification: final static selector audit, JS syntax audit, backend static QA, and asset/reference checks run on the release tree. Browser-level visual QA is documented separately where runtime/browser tooling is unavailable.


# Round 11 — Wordmark Fix + Store-Detail Redesign + Sitewide Polish

## Rollback restoration (user-requested)
- A `pages/` reorganization (10 secondary pages moved into `pages/` with `../` paths) was fully reverted at the user's request: all 19 HTML files are back in the project root, every `../` path prefix was rewritten back to root-relative (verified: zero `../` or `pages/` references remain in any HTML/JS), and the empty `pages/` folder was removed.
- Verified after restoration: all Round 11 edits intact (hero wordmark, consolidated CSS, store-scoped filters, footers), `js/store-detail.js` syntax-checked, backend static QA 23/23, and store-detail.html loaded in the browser with every CSS/JS/asset request succeeding (the only console errors are expected "backend unreachable" messages because no local database is running).

## Phase 1 — Hero wordmark contrast (root cause)
- `index.html`: the hero now shows the app icon (`icon-512.png`) above the solid-white wordmark (`wordmark-white.png`) — the same treatment as the round 9 build. The color wordmark asset renders "Nexta" in dark ink (#0B3B2B), which is nearly invisible on the dark hero; the white asset is the only variant with end-to-end contrast there. Single `.hero-brand` rule set in the page's inline styles; no second color rule for this element exists anywhere (searched all CSS/JS for wordmark/gradient-text/mask rules — none).
- Verification: page loaded in the embedded browser; wordmark, icon, eyebrow, headline and CTAs all legible against the real hero background.

## Phase 2 — store-detail.html redesign (delivered)
- Header rebuilt: larger 112px logo, name → rating/verified badge → description → product/follower/location facts hierarchy, "Message seller" as the primary action.
- Seller accent extended beyond the banner: message button tint, section divider, section-title underline, active category, sort focus ring, empty-state tinting — all keyed off `--store-accent` set from each store's existing banner color data (no backend fields added).
- Zero-product empty state made intentional: "This store is still stocking its shelves" with Message seller + Browse Other Stores actions, tinted with the store accent (verified live in-browser).
- Backend constraint noted: per-store layout templates would need a new seller-chosen field; not built. The accent system uses only existing data (`bannerColor`/`logo`).
- Visual distinctness verification (honest scope): live comparison of two seeded stores was NOT possible in this session because no local database is running (Postgres binaries absent; only the data directory exists). The accent pipeline itself was verified live: with no store data the page correctly falls back to the default green and renders the graceful empty state. The two-store visual-distinctness check on the checklist remains OPEN pending a running backend.

## Phase 3 — Store-scoped filters
- `js/store-detail.js` `renderStoreFilters()`: category list is now derived from the store's actual inventory (labels match product-form.html options); a dimension with 0 or 1 possible values is hidden (single-category stores see no category filter; single-price stores see no price filter); a store with zero products renders no filter panel at all; a missing store hides the About card too.
- Empty-filter state: filtering to zero results shows a "No products match your filters" state with a working Reset (reset re-derives the filter panel).
- `marketplace.html` filters untouched — still global.

## Phase 4 — Sitewide footer (user-directed standard: the index.html footer)
- The index.html `.footer` styles were promoted into `css/main.css` as the single canonical definition (removed from index.html inline styles; the interim `.site-footer-slim` variant was removed entirely).
- The exact index.html footer (brand lockup, Features/Marketplace/Create account/Shop/Support links, © 2026 NextaStore, Powered by Nextawills Technologies, Trust & Safety) now ends 13 pages: index, marketplace, dashboard, store-builder, store-detail, stores, cart, orders, admin, safety, product-detail, messages, product-form.
- Deliberately minimal: the five auth/onboarding pages (login, signup, forgot-password, verify-email, onboarding) keep their full-screen card layout and bare Trust & Safety line — a dark marketing footer under a centered auth card would look broken. Flagged here as an intentional page-specific exception; say the word if you want them converted too.
- Dead footer CSS removed in place: `.marketplace-footer`/`.footer-content`/`.footer-section`/`.footer-bottom`/`.social-links` (marketplace.css), `.dashboard-footer` (dashboard.css), `.builder-footer` (store-builder.css), `.store-footer` (store.css), `.simple-page-footer` + `.site-footer-slim` (main.css). Selector-count audit after cleanup: zero duplicate top-level selectors in every stylesheet (helper: `qa-duplicate-selectors.js`).
- Verification: footer structure + brand image load confirmed live in-browser on store-detail.html and errors/404.html.

## Phase 5 — Product grid consistency
- Single standard applied on every grid: square `aspect-ratio: 1/1` image wells (marketplace, store-detail, dashboard storefront + manage grids, product-detail related grid — fixed-height/px-height variants and their mobile overrides removed so the ratio holds at every breakpoint), identical hover (border + `--shadow-lg` + translateY(-3px)), 2-line clamped titles, and `--primary-dark` bold prices sitewide (store-detail and related-product prices moved off one-off ink/black values).
- Skeleton treatment remains the shared `.skeleton` shimmer in `main.css` used by all grids (marketplace, dashboard storefront, messages list); no page ships its own skeleton color.

## Phase 6 — Buyer-side store browsing
- Sort/filter sit in a dedicated sidebar with clear separation from the "Shop this store" grid; the About card now shows only backend-supported facts (verified, product count, completed orders, location) — the invented "response time / shipping" placeholder rows are gone.
- Product count feeding the heading comes from real data; the old static "All Products" heading is now "Shop this store"/"Shop <Category>" with a live count attribute.

## Error pages (user-requested)
- New `errors/` folder: `404.html`, `401.html`, `403.html`, `500.html` + shared `errors.css` — each with the brand topbar, dark hero with the code in brand green, a "Things you can try" card, context-aware actions (401 → sign in/create account), and the same standard footer as every page.
- Fixed a cascade bug found in live verification: `.error-hero p` outranked `.error-code`, rendering the code gray instead of brand green — resolved with a higher-specificity `.error-hero .error-code` selector (same failure class as the round 9/10 bugs, caught and fixed before shipping).
- Backend intentionally untouched: it is a JSON API whose `notFound`/`errorHandler` correctly return JSON for `/api` routes; wiring these static pages into a host's 404/500 config is a deployment-host step (flagged for the deploy checklist).

## Footer restore + blend polish (user request, later session)
- **Marketplace footer restored**: the multi-column directory footer (brand blurb, Quick Links, Support, Connect/social, bottom legal line) is back in `marketplace.html` with its `.marketplace-footer` CSS restored in `marketplace.css` including the 768px/480px responsive column breakpoints. Two upgrades over the original: "All Stores" and "Trust & Safety" added to Quick Links/Support, and the footer lockup switched from the colored `lockup-horizontal-512.png` to `lockup-horizontal-white.png` — the colored lockup's dark "Nexta" text was illegible on the dark footer (same contrast-bug class as round 10's header bug; caught during live verification).
- **Shared footer blend polish** (`main.css` `.footer`): all 13 standard-footered pages (index, cart, orders, stores, store-detail, store-builder, dashboard, admin, safety, product-detail, product-form, messages) now sit on a deep brand gradient (`#143830 → --ink`) with a thin `--primary` top edge — matching the marketplace footer palette so every page ends on the same brand treatment. Tighter link gaps, refined sizes, hover transitions, and the Trust & Safety link restyled inside the footer.
- Verified live: marketplace footer (4 columns, 3 social buttons, white lockup fully legible, gradient background) and 404 page; cart/index/store-detail use the identical `.footer` markup (13/13 pages confirmed by grep) and the shared CSS is single-definition (selector audit still 0 duplicates). The embedded browser session wedged before the post-polish cart screenshot; the `.footer` gradient formula was verified via computed style on the marketplace footer which uses the identical declaration.

## Marketplace footer light theme (user request, later session)
- `.marketplace-footer` switched from the dark gradient to a light theme: white → soft green-tinted gradient (`#FFFFFF → #F3FAF6`) with the same thin `--primary` top edge. All footer text recolored for the light surface (ink/gray links with `--primary-dark` hovers, white social tiles with green hover), and column headings bumped from `--gray-400` to `--gray-500` for ~4.6:1 contrast on white.
- Footer lockup switched back to the colored `lockup-horizontal-512.png` — correct now, since its dark "Nexta" text needs exactly this kind of light surface (the dark-footer version used the white lockup for the same reason).
- Verified statically: all referenced tokens defined once in `main.css`, no dark-theme leftovers in the footer block (remaining white rgba values belong to the intentionally-dark `.cta-*` section), selector audit clean, backend static QA 23/23. The embedded browser session was wedged (empty document/black captures) so the rendered screenshot could not be re-taken; the palette is the same token set already verified live on light surfaces elsewhere.

## Error page redesign (user request, later session)
- All four pages (`errors/404.html`, `401.html`, `403.html`, `500.html`) rebuilt to a modern minimal treatment in `errors.css`: full-viewport centered stage on soft paper with brand radial glows, colored top lockup, oversized gradient error code (green→dark, display font), one short headline, one subline, two pill CTAs, one-line legal footer. The wordy "Things you can try" card is gone; the only remaining helper text is a single hint line on 404 and 500.
- Full favicon set wired on every error page (ico + 16/32/48/64 png + apple-touch-icon) plus `theme-color` and `noindex`.
- 404 verified live in-browser: gradient code, lockup, CTAs, and legal line all render correctly. 401/403/500 share the exact same verified layout with only copy/CTA changes.

## Custom popups (user-requested audit)
- Confirmed zero native `alert()` / `confirm()` / `prompt()` calls across all JS and HTML (including inline handlers and inline script blocks).
- Confirmed the branded `site-dialog` system (`app.confirm()` in `js/main.js`, styles in `main.css`) is the confirmation path; verified live in-browser: the danger-tone "Remove item?" dialog renders as a branded card with Cancel/Remove buttons — no browser chrome.

## Final QA (this round)
- `node --check` passes on all modified JS (store-detail.js from the carried-over work).
- Backend static QA script: 23/23 passed.
- CSS duplicate-selector audit: 0 duplicates across all 13 stylesheets.
- Browser-verified (embedded Chromium, file:// backend-down): index.html hero, errors/404.html, store-detail.html (graceful not-found + empty state + footer + custom dialog). All asset/CSS/JS requests load; only expected API-unreachable console errors.
- OPEN ITEMS (blocked on a running backend + seeded data, not on code): full 18-page console sweep, two-store visual-distinctness comparison, store-filter behavior against two different real inventories, and desktop/mobile width sweep. The local Postgres installation on this machine has no server binaries (only the data directory), so the API cannot start here; run `start-local.bat` on a machine with the DB available to complete these.

## Round 12 — Production hardening pass

### Seller onboarding, previews, and store URLs
- Onboarding now persists a real store slug alongside the store name.
- The slug auto-suggests from the store name for the untouched starter store,
  while warning sellers that changing an established URL can invalidate old
  links.
- Review now displays a real clickable storefront URL using the same
  `store-detail.html?store=<slug>` route customers use.
- The onboarding review remains based on the saved `this.store` record, so
  Step 4 reflects the values written by Steps 1–3 rather than a separate mock
  object.
- Store Builder keeps its role as the post-launch advanced settings surface;
  fake payment API-key fields were removed, SEO fields now have real IDs and
  persist through the existing store endpoint, and Builder previews use the
  real storefront route.

### Buyer/seller account correctness
- Fixed a real upgrade-flow bug: `POST /user/become-seller` returned the new
  seller role, but the frontend did not update its cached user before opening
  seller-only onboarding. The result could be an immediate redirect back to
  the marketplace. Both shared account navigation and marketplace upgrade
  flows now cache the returned seller user before redirecting.
- Logged-in users are no longer encouraged to create a second account from
  the homepage. Auth-aware Get Started/Create account links route an existing
  session to its current home; the signup page also redirects an already
  authenticated user. No logout prompt is needed.

### Notifications
- The notification bell is now part of the shared account navigation, so
  buyers and sellers get the same notification affordance instead of the bell
  existing only on the seller dashboard.
- The bell shows recent notification previews and supports Mark all read.
  The shared bell feed includes recent message previews as well as general notifications; the Messages page remains available from the account menu.
- Buyer order placement and seller order-status changes now create persistent
  notification rows.

### Catalog/search scalability
- `/store/public/all` is now paginated and supports server-side search,
  category, and rating filters.
- `/products` is always bounded and paginated; it now supports server-side
  name search, category, price range, and sort order.
- Storefront, seller dashboard, Builder, and store directory use bounded pages
  and Load more rather than downloading an entire catalog.
- Marketplace autocomplete now calls a bounded server search endpoint rather
  than searching only the small deals list already loaded on the page.
- Added PostgreSQL trigram search indexes and store/product filter indexes.
- Added a partial unique PostgreSQL index for general buyer/store
  conversations and a data-repair step for any old duplicate general threads.
- Duplicate product/store lines are rejected at order validation.

### Order integrity
- Seller order-status transitions are now validated instead of allowing
  arbitrary jumps.
- Cancelling an order restores reserved stock and reverses its sold count,
  preventing inventory from permanently disappearing after cancellations.
- Low-stock notifications are emitted when stock crosses the threshold rather
  than on every subsequent edit while it remains low.

### Security and release hygiene
- Removed the bundled backend `.env` containing a real database credential.
- Removed runtime uploads from the production release tree; only an empty
  uploads directory marker remains.
- Public store responses are now whitelisted so owner IDs, seller contact
  internals, and private SEO/analytics data are not exposed.
- Production boot now fails fast unless transactional email, frontend URL,
  public asset URL, database, JWT secret, and exact CORS settings are present.
- Updated backend README to remove stale claims about missing pagination and
  password reset functionality and to document the remaining operational
  production requirements.

### Verification
- Static source/link/duplicate-asset audit performed.
- All JavaScript files will be syntax-checked before release packaging.
- Prisma runtime integration remains OPEN in this environment because there is
  no running PostgreSQL/Prisma engine available here; run migrations and the
  integration suite against a real PostgreSQL staging database before public
  traffic.


## 2026-09-15 — Seller Pass truth + global badge UX
- Added a corrective production migration that removes the legacy five-year subscription grant from stores that have no approved subscription payment, while preserving genuinely approved payments.
- Made the Verified Seller badge a live paid-subscription signal so an expired paid period cannot continue displaying the badge.
- Reworked `subscription.html` / `css/subscription.css` / `js/subscription.js` around a clearer Seller Pass journey, exact-total amount automation, payment-account guidance, review states, and stronger mobile UX.
- Added the compact seller verification mark to the shared account navigation wherever a seller's current paid subscription is confirmed, including onboarding.
- Added server-side exact amount enforcement so a seller cannot submit a mismatched amount for the selected coverage period.


## 2026-09-15 — Commitment badges replace seller ratings
- Retired Store-level seller ratings and the public rating filter; product ratings/reviews remain a separate product-feedback feature.
- A Verified Seller badge now requires an approved paid commitment of at least 6 months.
- Added Gold Partner (12+ months) and Platinum Partner (24+ months) tiers, plus a non-trust "Store Ready" badge based on visible storefront completeness.
- Added `Store.badgeCommitmentMonths` so the latest approved commitment is explicit and badge state cannot be inferred from stale five-year rollout grants.
- Updated marketplace, directory, storefront, dashboard, product seller card, order serialization, and account navigation to use the shared badge renderer.

## 2026-09-19 — Two-tier notification state (bell badge vs. item unread)

Previously a single `readAt` column drove both the exterior bell badge and
each item's unread highlight, so "Mark all as read" and the bell's own
polled count were really the same signal wearing two hats — there was no
way to acknowledge the bell (clear the badge) without also marking every
item read.

- **Schema**: added `Notification.acknowledgedAt` (migration
  `20260919210000_notification_acknowledged_at`, nullable, indexed with
  `userId`). `readAt` is unchanged and keeps doing exactly what it did
  before — it is the per-item "is this notification read" signal.
- **API** (`src/routes/notifications.js`):
  - `GET /notifications/unread-count` now counts `acknowledgedAt: null`
    instead of `readAt: null` — this is the number that feeds the exterior
    badge on every page via the existing polling loop, so no frontend
    polling change was needed beyond the bell-click handler below.
  - `GET /notifications` now returns both `unreadCount` (item-level,
    `readAt`-based) and `bellCount` (badge-level, `acknowledgedAt`-based).
  - New `PUT /notifications/acknowledge`: stamps `acknowledgedAt` on every
    unacknowledged row for the user, touching nothing else. This is what
    opening the bell calls.
  - `PUT /notifications/:id/read` and `PUT /notifications/read-all` now
    also stamp `acknowledgedAt` (a read notification is definitionally
    seen), so the badge count never drifts out of sync in the other
    direction — e.g. tapping a notification before ever opening the bell
    still decrements the badge correctly.
- **Message notifications** (`src/helpers.js` `notifyNewMessage`,
  `src/routes/messages.js` in-thread settle path): opening the target
  conversation directly still settles that notification's `readAt` *and*
  `acknowledgedAt` together (reading the actual content is stronger than
  acknowledging the bell). When a already-surfaced message notification
  gets fresh content and is bumped back to the top of the list, it's now
  explicitly un-acknowledged (`acknowledgedAt: null`) so the badge re-lights
  for the new message rather than staying silently at 0.
- **Frontend** (`js/main.js`): the bell-open click handler now zeroes the
  badge locally and fires `PUT /notifications/acknowledge` (keepalive,
  fire-and-forget) instead of relying on the list response to drive the
  badge. `loadNotificationPreview()` no longer touches the badge at all —
  it only renders each item's own `.is-unread` state from `readAt`, which
  was already correct and untouched by this change.
- **Verification**: `node --check` clean on every modified file (`main.js`,
  `notifications.js`, `messages.js`, `helpers.js`); backend static QA
  40/40 (unchanged — this feature has no static-QA coverage yet, flagged
  as an open item below). Not verified against a live database in this
  session — no Postgres reachable from this sandbox (network disabled). The
  logic was checked by tracing every call site that touches `readAt` or
  `acknowledgedAt`, but run `migrate:deploy` and click through: (1) receive
  a notification, confirm the exterior badge shows it before opening the
  bell; (2) open the bell — badge → 0, item still highlighted unread; (3)
  tap that item — highlight clears, badge stays 0; (4) trigger a second
  notification, confirm badge shows 1 again without affecting the first
  item's now-read state; (5) "Mark all as read" clears every remaining
  highlight and the badge.
- **Open item**: no automated integration-test coverage added for the new
  acknowledge endpoint or the two-tier split (the existing
  `scripts/integration-test.js` doesn't touch notifications at all yet).

## 2026-09-19 — Dynamic payment methods (IN PROGRESS, not fully complete)

Objective #5 asked to remove hardcoded payment gateways from the frontend
and fetch them dynamically from `/api/payments/methods` with
`is_active`/`currency`/`allowed_countries`/`environment` flags. Important
context this app doesn't share with a typical checkout spec: NextaStore
never processes payment at all — checkout explicitly tells the buyer "No
payment is processed by NextaStore," and `paymentMethod` on an order is
only an "intended payment method" signal the buyer and seller settle
between themselves. So this was implemented as a real backend-driven
catalog replacing the hardcoded method list, not as a Stripe/PayPal/
Flutterwave SDK integration, which would misrepresent what the product
does. `currency`/`allowedCountries`/`environment` are included as schema
fields since they were explicitly requested, but flagged honestly below as
currently-unused scaffolding — the rest of the app has no multi-currency
or multi-country concept anywhere yet.

### Done this round
- **Schema**: new `PaymentMethod` model (migration
  `20260919213000_payment_method_catalog`) — `code`, `label`, `icon`,
  `isActive`, `currency` (default `UGX`, unused elsewhere today), 
  `allowedCountries` (default `[UG]`, unused elsewhere today), 
  `environment` (`live`/`test`), `sortOrder`. Seeded with the exact four
  codes/labels already in use (`cash`, `mtnMomo`, `airtelMoney`, `card`) so
  applying the migration changes nothing about what a store can already
  offer.
- **API**: `GET /api/payments/methods` (public, optional `?storeId=` to
  pre-filter by that store's own `Store.payments` opt-in) backed by a new
  `getActivePaymentMethods()` helper that also hides `environment: 'test'`
  rows outside production. Admin CRUD at `/api/admin/payment-methods`
  (GET/POST/PUT/DELETE), gated by the existing `SETTINGS_MANAGE`
  permission — no new permission invented, consistent with the
  `/admin/settings` pattern it sits next to.
- **`orders.js`**: both `paymentMethod` validation blocks (`POST /public`
  and `POST /batch`) now build their label lookup from
  `getActivePaymentMethods()` instead of a hardcoded
  `{cash,mtnMomo,airtelMoney,card}` object literal duplicated in two
  places. This is a genuine correctness improvement, not just a refactor:
  a platform-wide-disabled method can no longer be forced through a
  checkout just because a store's own `payments` JSON still has it
  switched on.
- **`cart-page.js`**: `paymentOptions()` no longer hardcodes the four
  methods — `CartPageManager` fetches the live catalog once
  (`loadPaymentMethods()`) and intersects it with each store's own
  `payments` toggles, same UX as before.
- **`js/api.js`** (`?mock=1` dev-only demo layer): added matching mock
  responses for `GET /payments/methods` and `PUT /notifications/acknowledge`
  (the latter was missed in the previous round) so demo mode keeps working.
- Backend static QA still 40/40; `node --check` clean on every modified
  file.

### NOT done yet — open for next session
- **`store-builder.html` / `store-builder.js`**: the seller-facing "Payment
  Methods" settings panel still hardcodes exactly three checkboxes
  (`mtnMomo`, `airtelMoney`, `card` — no `cash` toggle exists here at all)
  wired to their DOM position by array index (`keys[i]` / `paymentKeys[i]`
  in `js/store-builder.js`). This needs converting to render one checkbox
  per method returned from `/payments/methods`, so a method an admin adds
  or removes from the catalog actually appears/disappears here without a
  frontend redeploy. Not started.
- **`dashboard.js`** (~line 387-390): the read-only payment-badge summary
  on the seller dashboard overview (`paymentMTN`/`paymentAirtel`/
  `paymentCard` DOM ids) is still hardcoded to exactly those three methods
  and won't reflect a catalog change either. Not started.
- No automated test coverage added for the new endpoints (same gap as the
  notification round — `scripts/integration-test.js` doesn't touch
  payments or notifications yet).
- Not verified against a live database in this session (no Postgres
  reachable from this sandbox) — same caveat as the notifications round.
  Run `migrate:deploy`, then check: (1) `GET /api/payments/methods` returns
  the seeded four; (2) cart checkout dropdown still shows the same options
  per store as before; (3) disabling a method via
  `PUT /admin/payment-methods/:id` makes checkout reject it even if a
  store's own toggle is still on.

---

## Round 9 · Step 4 — Store Builder removed, everything lives in Settings > Store

**Why:** onboarding already covers first-run setup, so a second "Store Profile"
page was a duplicate editor for the same `PUT /store` record.

- **Deleted:** `store-builder.html`, `js/store-builder.js`, `css/store-builder.css`.
- **`dashboard.html` / `js/dashboard.js`:** Settings > Store is now the single
  place to edit the store: Basics (name, store URL/slug with copy-link, description,
  contact email, phone), Location (district, map pin, address, directions),
  Branding (logo, banner image, banner colour, colour presets), Payments, and
  Search & sharing (SEO fields). Jump chips scroll within the form; the save bar
  is sticky with safe-area padding. Renaming the slug shows the new link and warns
  that already-shared links stop working.
- **Payments (closes the two open items from the previous round):** the seller
  payment checkboxes and the overview badges are now rendered from
  `GET /payments/methods` instead of three hardcoded methods matched by array
  index. Only rendered methods are sent on save; the backend merge leaves methods
  retired from the catalog untouched.
- **`css/store-form.css`** (new) holds the controls onboarding and Settings share
  (logo/banner upload, colour presets, colour picker, payment rows, link field).
  `onboarding.html` links it instead of `store-builder.css`; the duplicate colour
  picker rules were removed from `dashboard.css`.
- **Dropped without replacement:** the builder's Products panel (Dashboard >
  Products already does this), its live preview pane, and the Grid/List "Layout"
  picker — `store.layout` is stored but nothing on the storefront reads it.
  Colour presets remain and set the banner colour, as in onboarding.
- **Not wired to the storefront (pre-existing):** `store.seo` (meta title,
  description, keywords, analytics ID) is saved but no public page reads it yet.
  It is preserved in Settings so nothing is lost; rendering it is a follow-up.
- Cleanup: `auth.js` SELLER_ONLY_PAGES, `product-form.js` return path, stale
  comments; onboarding copy no longer points to "Store Profile"; service worker
  cache bumped to `v6` so the removed page/CSS are purged from installed PWAs.
- Static QA 40/40; `node --check` clean on every JS file. Not exercised in a
  browser in this session (no DOM available in the sandbox) — please click through
  Settings > Store once: logo upload, map picker, payments toggle, save, reload.

---

## Round 9 · Step 5 — Store SEO: stores discoverable on Google and in link previews

**Problem:** `store-detail.html` is a JavaScript shell — one generic `<title>`,
no per-store meta, no sitemap, and WhatsApp/Facebook previews were blank. The
seller's "SEO" fields were saved but read by nothing.

- **`src/seo.js`** (new, dependency-free): renders a server-side page per store
  with unique title/description, canonical URL, Open Graph + Twitter tags,
  schema.org `Store` + `Product` JSON-LD (UGX prices, stock availability),
  crawlable product links and a "Shop this store" button. Also `robots.txt` and
  `sitemap.xml` rendering. Seller-controlled strings are HTML-escaped; JSON-LD
  is `<`-escaped; image URLs are validated before reaching CSS/HTML.
- **`src/routes/seo.js`** (new, mounted in `app.js`): `GET /s/:slug`,
  `/sitemap.xml`, `/robots.txt`. Only published, currently-active stores are
  served (everything else is a real 404); `/s/Mixed-Case` 301s to the canonical
  slug; pages cached 60s, sitemap 1h; own restrictive CSP so R2 images load;
  same per-IP limiter as the public catalog. `/api/` is intentionally NOT
  disallowed in robots.txt so Googlebot can render the JS pages.
- **`config.siteUrl` / `SITE_URL`** (new env): the public origin crawlers see.
  Defaults to this server in development, `FRONTEND_URL` in production.
  `serializeStore`/`serializePublicStore` now include `publicUrl`.
- **Settings > Store > Search & sharing:** search title, search description
  (length-capped, with a live Google-result preview) and a "Show my store in
  Google" toggle (`seo.indexable`, default on; off => `noindex` + omitted from
  the sitemap). The keywords field (Google ignores it) and the Analytics ID
  (nothing renders it) were removed from the form; existing stored values are
  left untouched by the backend merge.
- **Sharing:** dashboard share modal / copy-link now use the `/s/<slug>` URL so
  WhatsApp previews show the store. `store-detail.js` sets its canonical to that
  URL to avoid duplicate listings.
- **Tests:** `npm run test:seo` (10 checks: escaping, JSON-LD validity,
  noindex, unsafe URLs, sitemap, length caps). Static QA still 40/40.
- **REQUIRED at deploy:** route `/s/*`, `/sitemap.xml`, `/robots.txt` on the
  public domain to this API (proxy rule in README > "Search engine visibility"),
  set `SITE_URL`, then submit the sitemap in Google Search Console.
- **Not verified:** the Express routes were not run against a live DB/server in
  this sandbox (no installed dependencies or Postgres); only the renderer is
  unit-tested. Product detail pages (`product-detail.html`) are not yet
  server-rendered.
