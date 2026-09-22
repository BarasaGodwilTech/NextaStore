# NextaStore Production Release Audit

Date: 2026-09-13

## Release status

The source has received a production-hardening pass covering navigation,
onboarding persistence, buyer/seller account transitions, notifications,
search, catalog pagination, order integrity, security hygiene, and release
cleanup.

### Verified in this environment

- 18 frontend JavaScript files: syntax check passed.
- Backend source/scripts/server JavaScript: syntax check passed.
- Existing backend static QA: 23/23 passed.
- CSS duplicate-selector audit: passed.
- HTML duplicate-ID audit: 0 duplicate IDs.
- HTML local href/src audit: 0 broken local references found.
- Bundled production release excludes `.git`, `.env`, runtime uploads, and
  `node_modules`.
- A real database credential found in the supplied archive's `.env` was
  removed from this release tree.

## Important security action

The supplied archive contained a real PostgreSQL connection credential in a
backend `.env` file. Treat that credential as compromised and **rotate/revoke
it before production**, even though the `.env` is not included in this release.

Do not reuse the exposed database password.

## What was fixed

### Onboarding / Store Builder

- Onboarding saves each step through the real `PUT /api/store` path.
- Store URL/slug is now saved with Store Basics.
- The slug auto-suggests from the starter store name while the starter URL is
  still untouched, but sellers are warned that changing an established URL can
  invalidate old links.
- Step 4 displays a real clickable storefront URL using the same
  `store-detail.html?store=<slug>` route used by shoppers.
- Store Builder remains in the product because it has a distinct post-launch
  purpose: advanced branding, URL, layout, payment-method flags, SEO, and
  product management.
- Fake payment API-key inputs were removed because the current backend does
  not process or store payment credentials.
- SEO fields now have real IDs and persist.
- Store Builder product management is paginated with Load more.
- Onboarding/Builder/Product-form image uploads are resized client-side before
  being sent to the API, reducing oversized request failures.

### Buyer -> Seller

- Buyers can become sellers using the existing account.
- The frontend now stores the returned seller role immediately before opening
  seller-only onboarding. This fixes the previous immediate-redirect-to-
  marketplace failure caused by stale cached role data.
- Logged-in users clicking the homepage's auth-aware Get Started/Create account
  links are not logged out and are not silently given a second account.
- The signup page also redirects already-authenticated users.
- The intended model is one account that can browse and later become a seller.

### Notifications

- The bell is now shared by buyers and sellers through the account navigation.
- One bell feed contains recent general notifications and recent message
  previews.
- The account menu still links to the full Messages page.
- Buyer order placement and seller order-status changes create notifications.
- Notification badges are bounded and show `99+` instead of growing the UI.

### Search and data loading

- Marketplace autocomplete now uses a bounded server search endpoint instead
  of searching only the small locally loaded deals list.
- Store directory search/filtering is server-side.
- Storefront product search/filter/sort is server-side and paginated.
- Seller dashboard and Store Builder product lists are paginated.
- Product/order/store list APIs are bounded; the old unbounded `/products`
  behavior was removed.
- Storefronts and directories use Load more rather than downloading an entire
  catalog.
- PostgreSQL indexes were added for high-frequency product/store filters,
  sorting, search, notifications, and message retrieval.
- PostgreSQL trigram indexes support case-insensitive product/store name search.
- General buyer/store conversations now have a partial unique index so NULL
  product IDs cannot create unlimited duplicate general threads.
- Conversation/message retrieval is paginated so a very active inbox does not
  require loading every conversation/message into the browser.

### Order integrity

- Order lines reject duplicate product IDs.
- Stock reservation remains atomic at checkout.
- Seller status changes follow a controlled lifecycle.
- Cancelling an order restores reserved stock and reverses its sold count.
- Low-stock notifications fire when inventory crosses the threshold rather
  than on every edit while already low.
- Public store payloads no longer expose private ownership/contact/SEO
  internals.

## Production deployment requirements

The code is safer to deploy, but the following must be completed against
staging/production infrastructure:

1. Rotate the database credential that was present in the supplied archive.
2. Configure real `DATABASE_URL`, `JWT_SECRET`, `CORS_ORIGIN`, `FRONTEND_URL`,
   `PUBLIC_URL`, `SMTP_HOST`, and `SMTP_FROM`. Production boot now fails fast
   when required values are missing.
3. Run `npm ci`.
4. Run `npm run migrate:deploy` once as a deployment step before starting API
   instances.
5. Run `npm run test:integration` against a dedicated PostgreSQL test database.
   Never use a production database for the integration test.
6. Configure transactional email and verify both email verification and
   password reset delivery.
7. Use persistent/object storage for uploaded images before running more than
   one API instance. The current local upload adapter is not horizontally
   scalable on hosts with ephemeral disks.
8. Do not claim that NextaStore processed a payment. Current payment settings
   describe seller-accepted payment methods; there is no payment processor or
   webhook settlement flow yet.
9. Use HTTPS and exact CORS origins. Put the frontend/API behind the chosen
   reverse proxy/CDN and enable compression/caching there.
10. Prefer HttpOnly/SameSite cookie authentication plus CSRF protection before
    the platform handles higher-risk accounts at scale; the current browser
    token remains in localStorage.
11. Self-host or add a deliberate CDN/SRI strategy for third-party frontend
    assets such as Font Awesome and Leaflet.

## Database / scaling strategy

Current list endpoints use bounded page-based loading so the browser only
receives a small working set. This is appropriate for launch and avoids the
old "download the entire catalog" failure mode.

As datasets reach very large offsets, the next evolution should be cursor
pagination for feeds where deep offset scans become expensive. Keep response
contracts stable (`data` plus pagination metadata) so that migration can be
introduced without changing the domain model.

For images, move the existing `saveImageIfDataUrl()` implementation behind an
S3/R2-compatible object-storage adapter. The browser should eventually upload
directly with presigned URLs rather than sending large base64 JSON bodies
through the API.

## Runtime verification still required

This environment did not have a running PostgreSQL server or Prisma engine, so
database migrations and integration tests could not honestly be claimed as
runtime-verified here.

The staging gate is therefore:

- apply every migration from scratch;
- seed only the dedicated development/test database;
- exercise buyer signup, seller signup, buyer->seller upgrade, onboarding
  saves, slug/public storefront, product create/edit/delete, cart checkout,
  cancellation/restocking, messages, notifications, and admin moderation;
- test concurrent checkout for the last stock unit;
- test at least thousands of products/orders/conversations in staging;
- perform desktop/mobile browser smoke tests on every page.

