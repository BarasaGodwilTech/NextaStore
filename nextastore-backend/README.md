# NextaStore Backend

REST API for the NextaStore platform — auth, stores, products, orders, dashboard stats.
Runs on Express + PostgreSQL (via Prisma).

## What changed in this pass

Three rounds of work sit in this README. The first (below) moved the backend
off a flat JSON file onto real PostgreSQL. The second was a full audit that
found the frontend was never actually calling this backend at all, plus
several routes the frontend depended on that had never been built. The third
— this pass — adds buyer/seller account separation.

### Latest pass: buyer/seller role separation

- **Every signup created a store**, whether the person wanted to sell or just
  browse. Added a `role` (`buyer`/`seller`) column on `User`, an `accountType`
  field on `POST /auth/signup` (defaults to `buyer`), and made store creation
  conditional on it — a buyer signup creates no store at all.
- **No route distinguished buyer tokens from seller tokens** — a buyer's JWT
  worked against `POST /products`, `PUT /store`, `GET /dashboard/stats`, etc.
  as long as they happened to own a store, and nothing rejected them if they
  didn't beyond a generic 404. Added `requireSeller` middleware and applied
  it to every seller-only route, returning a real 403 with a clear message.
- **No upgrade path existed** for a buyer who decides to start selling later
  — the only way to get a store was to sign up a second time. Added
  `POST /user/become-seller`, which creates the same starter store a fresh
  seller signup gets and flips the role in one transaction.
- **Migration note**: `prisma migrate dev` could not be run in this sandbox
  (same `binaries.prisma.sh` network restriction noted in the section below)
  — the migration at `prisma/migrations/20260908160000_add_user_role/` was
  hand-written to match Prisma's format. It backfills `role = 'seller'` for
  every existing user who already owns a store, so this migration does not
  lock out any existing seller when `requireSeller` starts enforcing —
  treat "the migration applies cleanly" as unverified until you run it
  yourself, same caveat as the schema change below.

### Frontend/backend contract gaps + the unified banner system

- **The frontend had `useMockAPI = true` hardcoded** (`js/main.js`), so every
  screen was reading and writing an in-browser fake database, never this API.
  Fixed — real API by default, mock is opt-in via `?mock=1` for local UI work.
- **Three routes the frontend called did not exist on this server**, so the
  corresponding pages were non-functional for real users:
  - `GET /products/public/:id` — the public product-detail page was calling
    the owner-only `GET /products/:id`, which requires login and further
    restricts to the caller's own store. No logged-out shopper could ever
    view a product. Added a real public route.
  - `GET /store/public/all` — the marketplace's "browse stores" grid and the
    homepage's "Featured Stores" section both called this; it 404'd every
    time. Added, with one grouped product-count query instead of one COUNT
    per store.
  - `GET /store/public/:idOrSlug` — visiting a specific seller's storefront
    or product (from a marketplace card, a product page's breadcrumb, etc.)
    called this with either the store's id or its slug depending on which
    page linked there; neither ever resolved. Added, matching either.
- **`resolveContextStore` only matched by slug.** Some pages link to a store
  by id, not slug — it now matches either, so `?store=` works regardless of
  which one a given page happens to pass.
- **Stock could be oversold under concurrent checkout.** The stock check and
  the decrement were separate steps against a snapshot read at the start of
  the transaction, so two simultaneous orders for the last unit of a product
  could both pass the check. Fixed with an atomic conditional update
  (`updateMany` with `stock: { gte: quantity }`, checked by row count).
- **`district` / `detailedDirections` / `mapCoordinates`** were collected by
  the dashboard's Settings form but never existed on the `Store` model —
  Zod's default object parsing silently drops unrecognized keys, so these
  were "saved" successfully and then vanished on next load. Added to the
  schema and to `updateStoreSchema`.
- **SVG uploads removed** from accepted image types (`src/utils.js`) — an SVG
  can carry an embedded `<script>`, making logo/banner upload a stored-XSS
  vector. Raster formats only now.
- **`bannerColor` now has real validation** — a strict `#rrggbb` regex,
  since it's written straight into an inline `style` attribute on the
  frontend (a looser check there was a CSS-injection opening).
- **Unified banner system, default `#00B074`.** The Store model's
  `bannerColor` now defaults to `#00B074` (schema-level, so it applies to
  every new store automatically — no per-signup-flow code needed it). The
  frontend banner/logo upload flow, which previously wrote only to a
  `nextastore_appearance` blob in the browser's `localStorage` and never
  reached the API, now saves through `PUT /store` like every other setting.

### Earlier pass: JSON file → PostgreSQL

This backend used to store everything in a flat `data/db.json` file with images
written to local disk. That's gone. It's now backed by real PostgreSQL through
Prisma, with these production-correctness fixes made at the same time (they
had to happen together — see "Order integrity" below):

- **No more demo/seed data in any code path that can run in production.**
  Signup no longer auto-fills a new store with sample products. The old
  "Amina's Crafts", "Uganda Fashion Hub" etc. demo stores only exist now in
  `scripts/seed-dev.js`, which refuses to run when `NODE_ENV=production`.
- **Order totals and prices are computed server-side, always.** Previously an
  order's `total` was calculated from a `price` field the *client* sent in
  the request body — meaning anyone could open devtools and check out for
  whatever amount they wanted. Every order now looks up the real
  `Product.price` from the database inside a transaction and computes the
  total from that. Client-supplied price is never trusted or even read.
- **Stock is actually enforced.** Placing an order now checks
  `product.stock >= quantity` and decrements it inside the same transaction,
  so overselling isn't possible. Previously `stock` existed on the schema but
  nothing ever read or wrote it.
- **Soft deletes** on stores/products/orders (`deletedAt`), so a seller
  deleting a product doesn't corrupt historical order data. Order line items
  additionally snapshot `productName` + `unitPrice` at time of purchase, so a
  price change (or a deleted product) never rewrites history.
- **Input validation** (Zod) on every route that accepts a body, instead of
  ad-hoc `if (!x) throw` checks.
- **Security baseline**: `helmet`, rate limiting on `/api/auth/*`, CORS locked
  to real origin(s) in production, and the app now refuses to boot in
  production without a real `JWT_SECRET`/`DATABASE_URL`/`CORS_ORIGIN`.

The REST contract (endpoints, request/response JSON shape) is unchanged, so
the existing frontend (`js/main.js` → `apiRequest`) works against this without
any changes, once you point `apiBaseUrl` at your deployed API.

## Setup

```bash
cp .env.example .env
# edit .env — at minimum set DATABASE_URL to a real Postgres instance
# (Supabase/Neon/Railway all have a free tier good enough to start on)

npm install              # also runs `prisma generate` via postinstall
npm run migrate:dev       # creates the schema in your dev database — see note below
npm run seed:dev           # optional — demo login: amina@example.com / password123
npm run dev
```

**If you already have a database from before this pass** (i.e. you've run
`migrate:dev` on this project previously), a migration for the new `role`
column already exists at `prisma/migrations/20260908160000_add_user_role/`
— `npm run migrate:deploy` (or `migrate:dev`) will pick it up and run it,
including the backfill that marks existing store owners as `seller`. You
don't need to generate a new one for this change. Earlier passes added three
columns to `Store` (`district`, `detailedDirections`, `mapCoordinates`) and
changed `bannerColor`'s default; if you're catching up from further back
than that, `migrate:dev` will still detect the full diff and walk you
through it. If this is a **brand-new** database, `migrate:dev` just creates
everything in one shot as usual.

This sandbox's network doesn't allow reaching `binaries.prisma.sh` to
download the Prisma query engine, so `prisma generate`/`migrate`/`validate`
couldn't actually be run and verified end-to-end here — run them in your own
environment as the first real check.

## Deploying

```bash
npm ci
npm run migrate:deploy    # prisma migrate deploy — explicit, separate from app boot
npm start
```

Important: `migrate:deploy` is **never** run automatically by `server.js`.
Run it as its own deploy step, once, before starting new instances. Running
migrations from inside app boot is what causes race conditions the moment
you run more than one instance — two instances both trying to migrate at
process start.

Take a database backup (or confirm your host's automatic backup + point-in-time
recovery is on) before any migration that touches existing data.

Required production environment variables (the app throws on boot if these
are missing/wrong — see `src/config.js`):
- `DATABASE_URL` — your Postgres connection string
- `JWT_SECRET` — long random value, e.g. `openssl rand -hex 32`
- `CORS_ORIGIN` — your real frontend origin(s), comma-separated. Not `*`.

Also update `apiBaseUrl` in `js/main.js` (frontend) from `http://localhost:4000/api`
to your deployed API's real URL before going live. As of this pass this
happens automatically for you in most setups (it detects `localhost` vs. any
other hostname and falls back to `${origin}/api`) — you only need to touch it
if your frontend and API live on different origins, in which case add
`<meta name="nextastore-api-base" content="https://your-api.example.com/api">`
to each HTML page's `<head>` instead of editing the JS file.

## Search engine visibility (Google, WhatsApp previews)

The storefront pages (`store-detail.html`) are a JavaScript shell, so on their
own every store shares one generic title and link previews are blank. The API
therefore serves a real, server-rendered page per store:

| Path | What it is |
| --- | --- |
| `/s/<store-slug>` | Store landing page: unique title/description, canonical URL, Open Graph + Twitter tags, schema.org `Store` + `Product` JSON-LD, crawlable product links, "Shop this store" button into the app |
| `/sitemap.xml` | Every published, currently-active store that hasn't opted out (max 50,000 URLs; cached 1h) |
| `/robots.txt` | Allows the public site, blocks private pages, points at the sitemap |

Only published stores inside their trial/paid window are served (anything else
returns a real 404, so Google drops it). A seller can opt out under Settings >
Store > Search & sharing (`seo.indexable = false` renders `noindex` and removes
the store from the sitemap).

**Required infrastructure step.** These paths must be reachable on the *public
site's own domain*, not just the API host. With a reverse proxy in front of
both (nginx shown; Cloudflare/Caddy/Railway equivalents work the same way):

```nginx
location ~ ^/(s/|sitemap\.xml$|robots\.txt$) { proxy_pass http://api_upstream; }
location /api/ { proxy_pass http://api_upstream; }
# everything else -> the static frontend
```

Then set `SITE_URL` (and `FRONTEND_URL`) to that domain. Without the proxy rule
the canonical/share links would point at 404s.

After deploying: submit `https://<your-domain>/sitemap.xml` in Google Search
Console (Sitemaps) and use URL Inspection on one `/s/<slug>` page to confirm it
renders. Indexing is not instant — for a new domain expect days to weeks, and
Google decides what to index and how it ranks; nothing here can guarantee a
position.

Tests: `npm run test:seo` (renderer, escaping, JSON-LD, sitemap; no DB needed).

## Web Push (mobile notifications)

Push is being delivered in two packages. **Package 1 (this one)** is everything
that runs on the server and inside the service worker. **Package 2** adds the
page side (`js/push.js`: the "turn on notifications" prompt, subscribing, the
Settings switch and the bell shortcut). Until package 2 is in, nothing in a
browser ever asks for permission or subscribes, so no device receives a push
yet, even though the pieces below are all in place and tested.

| Piece | Where | What it does |
| --- | --- | --- |
| Sending | `src/push.js` | `sendPushToUser()` is called by `createNotification` / `notifyNewMessage`. Sends `{ type, title, body, link }` to every device the person registered, keeps messages for at most 24 h (TTL), and deletes any device the push service reports as gone (404/410). Never throws. |
| Routes | `src/routes/push.js` | `GET /api/push/public-key`, `POST /subscribe`, `POST /unsubscribe`, `GET /status`, and `POST /test` (sends a test notification to the caller's own devices only; one per 30 s per person, then `429` with `Retry-After`). |
| Displaying | `service-worker.js` | `push` always shows a visible notification (even for an empty or malformed payload, which iOS requires); messages replace each other per conversation, orders stack; `notificationclick` re-validates the link, then focuses / navigates an open window or opens one; `pushsubscriptionchange` re-subscribes and tells an open page. Open pages also get an `ns-push-received` message so the bell can refresh. |
| Cleanup | `removeAllSubscriptionsForUser()` | Runs on log out everywhere, password reset, password change and account suspension. Those end the *logins*, but a phone's push subscription is separate, so without this it would keep showing message previews on a signed-out lock screen. |

**To turn it on for a deployment**

1. `npm run generate:vapid-keys` once per environment, put the three lines in that environment's variables (see `.env.example`), restart the API. Without keys the API reports `enabled: false` and never sends.
2. Serve the site over **HTTPS** (browsers refuse push on plain HTTP except `localhost`). The API origin can differ from the site origin; the service worker must be served from the site root.
3. **iPhone/iPad** (iOS 16.4+): push only works for the app *added to the Home Screen*, and the permission request must come from a tap. The page module in package 2 handles both; a normal Safari tab can't receive push.

**Things that behave in ways you might not expect**

- A notification is shown even while a NextaStore tab is focused. iOS revokes subscriptions that receive pushes without showing anything, so we accept one redundant banner.
- A session that simply *expires* (rather than being logged out) cannot unsubscribe its device because its token is already invalid. That phone keeps receiving pushes until the next person who signs in on it triggers the page module's cleanup of subscriptions they didn't opt into (package 2).
- The `/test` throttle is in memory, per server process. With several instances the limit is per instance.

**Testing**

```bash
npm run test:push          # service worker handlers + backend send/cleanup/test-route logic; no browser, DB or network
npm run test:push-browser  # the real service worker in real Chromium, pushes injected via DevTools
                           # (once: npm i --no-save playwright && npx playwright install chromium)
npm run qa:static          # includes checks that every session-revocation path also removes push devices
```

By hand: DevTools > Application > Service Workers > *Push* with
`{"type":"new_message","title":"Test","body":"Hi","link":"messages.html?conversation=abc"}`
shows the notification without any server. Tapping a notification and real
delivery to a phone can't be automated; test both on a device over HTTPS.

What the automated tests do **not** prove: that Express mounts the routes, that
the Prisma queries run on Postgres (the backend test uses stubs; `node_modules`
and a database weren't available), or that a real push service accepts a
message. Hit `POST /api/push/test` on a running server once after deploying.

## Amina's Store reference color

The request that drove this pass named `#00B074` as "the green used in
Amina's Store" and asked for it as the platform default. Worth flagging: the
demo data in `scripts/seed-dev.js` had Amina's store hardcoded to `#1F6F5C`
(a darker green) before this change — not `#00B074`. Both the schema default
and the seed data now use `#00B074` as given, so they're consistent with each
other and with this request, but if `#1F6F5C` was actually the intended
reference color, that's a one-line fix in two places (`schema.prisma`'s
`bannerColor` default and `scripts/seed-dev.js`).

## Production readiness — remaining launch requirements

The application now has the important correctness/scaling foundations in place:
bounded public feeds, paginated product/order/store APIs, server-side product
search, atomic stock reservation, cancellation restocking, role-gated seller
writes, public payload minimization, notification previews, and database
indexes for the main store/product/message paths.

Before production traffic, complete these operational items:

1. **Payment processing is not integrated.** Payment-method toggles currently
   tell shoppers which methods a seller accepts; NextaStore does not charge or
   verify payments. Do not describe an order as paid until a real MTN MoMo,
   Airtel Money, card processor, or equivalent webhook flow is implemented.
2. **Object storage is already wired to R2** (`src/utils.js`, gated on the
   `R2_*` env vars — see `.env.example`), which is what makes horizontal
   scaling and ephemeral-disk hosts safe. There is no local-disk fallback in
   production; set the R2 vars before your first deploy or image uploads
   will fail loudly rather than silently landing on one instance's disk.
3. **Transactional email must be configured.** Production boot now fails fast
   unless SMTP settings and `FRONTEND_URL`/`PUBLIC_URL` are present. Verify
   email and password-reset delivery with a real provider before launch.
4. **Run migrations before starting instances.** `npm run migrate:deploy` is
   deliberately separate from `npm start`, so multiple instances cannot race
   migrations.
5. **Run the integration suite against a real PostgreSQL test database.**
   Static checks can validate contracts, but concurrency, migrations,
   transactions, indexes, and real Prisma queries need a database.
6. **Serve the frontend and API behind HTTPS and a reverse proxy/CDN.**
   Configure exact `CORS_ORIGIN`, compression/caching at the edge, and
   immutable caching for fingerprinted/static assets.
7. **Move authentication to secure HttpOnly cookies before handling
   higher-risk accounts.** The current browser token is stored in
   `localStorage`, which is convenient but less resistant to an XSS incident
   than an HttpOnly/SameSite cookie plus CSRF protection.
8. **Self-host or pin third-party frontend assets where availability matters.**
   Font Awesome and Leaflet are currently loaded from CDNs; production should
   either self-host them or add a documented CDN/SRI strategy and a CSP.

### Data-loading strategy

Public lists are intentionally bounded. Store directories, seller product
management, storefront products, and order history load a small page at a
time and expose "Load more"/pagination rather than downloading the entire
table. Search previews use a bounded `/api/store/search` response. PostgreSQL
indexes support the high-frequency store/product filters and case-insensitive
name search.

The next scaling step after ordinary page-based browsing is cursor pagination
for feeds that can grow into very large offsets. Keep the API response shape
stable (`data` plus `pagination`) so the frontend can adopt cursor tokens
without changing the domain model.

### Scale hardening pass (2026-09-17)

A few places didn't live up to the "bounded" promise above. Fixed in this
pass:

- **`GET /api/orders` could return a seller's entire order history in one
  request.** `listOrdersForOwner()` has an unbounded mode (`take: undefined`)
  that `/orders/recent` relies on internally with a hardcoded `limit: 5`. The
  public route now always defaults `page` before calling it, so that branch
  can never be reached from outside — a caller that simply forgets `?page`
  gets page 1, not the whole table. The dashboard's Analytics tab used to hit
  exactly this: it called `/orders` with no params to compute revenue/KPI
  numbers client-side, so opening Analytics got slower every time the store
  sold something, forever.
- **New `GET /api/dashboard/analytics?days=N`** replaces that client-side
  reduction with SQL aggregates (`GROUP BY` day for the revenue chart,
  `GROUP BY` category joined through `OrderItem`/`Product` for the category
  breakdown) scoped to the requested window. Cost now scales with the
  selected period, not with total history.
- **`GET /api/dashboard/stats`'s distinct-customer count** used
  `findMany({ distinct: ['customerPhone'] })`, which still has to fetch one
  row per distinct customer just to read `.length`. Replaced with a single
  `SELECT COUNT(DISTINCT "customerPhone")` — one row back, work stays in
  Postgres.
- **The marketplace page's category tabs and search box only ever searched
  the first 12 stores / 60 products it happened to load on page open** —
  everything after that was filtered in the browser from that fixed array,
  even though `/store/public/all` and `/products/public` already support
  `category`/`q`/pagination server-side. A store or product outside that
  first page could never appear in a filtered or searched result, no matter
  how well it matched. `js/marketplace.js` now calls those endpoints with
  the actual filter/search params instead.
- **Text search (`contains` / `ILIKE '%term%'`) can't use a plain B-tree
  index at all** — Postgres falls back to a sequential scan, which is
  invisible at a few hundred rows and gets linearly slower as the catalog
  grows. Migration `20260917120000_trigram_search_indexes` adds `pg_trgm`
  GIN indexes on `Product.name`/`description` and
  `Store.name`/`description`/`district`/`address`. Requires the `pg_trgm`
  extension enabled on your Postgres instance (see the migration file).
- **Responses were uncompressed.** `compression` (gzip/brotli negotiation)
  is now applied in `src/app.js` ahead of the route handlers, run
  `npm install` to pull it in.

Still worth doing before a large seller base is a real concern:

- **Set an explicit Postgres connection-pool size.** Prisma opens a pool
  sized off available CPU cores by default, which is usually fine for one
  instance but can exhaust your database's `max_connections` once you run
  several API instances (or a serverless platform that scales instance
  count with traffic). Add `?connection_limit=<n>` to `DATABASE_URL` (a
  common starting point is `max_connections / expected_instance_count`),
  and put PgBouncer in front of Postgres if you expect many short-lived
  instances (serverless, autoscaling) rather than a small fixed pool of
  long-running servers.
- **Rate-limit public, unauthenticated endpoints**, not just auth. Login/
  signup already use `express-rate-limit` (`src/routes/auth.js`); the
  public catalog/search endpoints (`/products/public`, `/store/public/all`,
  `/store/search`) have no such protection yet and are the ones most
  exposed to scraping or accidental hot-loop traffic from a buggy client.
- **Cache the most-requested public reads at the edge or in Redis** —
  `/products/deals`, `/store/public/all`'s first page, and individual
  storefronts change on the order of minutes, not milliseconds. A short
  (30–60s) `Cache-Control`/CDN cache or a Redis layer in front of these
  removes repeat load from Postgres entirely for the majority of traffic,
  which is the highest-leverage change once you have real concurrent users
  rather than a scale-of-data problem alone.

### Store Builder vs onboarding

Both are intentional:

- **Onboarding** is the first-run launch wizard and saves each step
  immediately through `PUT /api/store`.
- **Store Builder** remains the post-launch advanced settings surface for
  branding, URL, layout, payment-method flags, SEO metadata, and product
  management.
- The Builder no longer presents fake payment API-key fields. It only exposes
  settings the current backend actually persists.
- Preview URLs now point to the same `store-detail.html?store=<slug>` route
  used by shoppers, so a seller can verify the real storefront rather than a
  disconnected mock preview.

### Buyer → seller account model

There is one account per person. A buyer who chooses **Become a seller** is
upgraded in place, the returned seller role is immediately cached by the
frontend, and the user is sent to onboarding. A logged-in user who clicks a
public **Create account/Get started** CTA is not logged out and is not silently
given a second account; they are taken to the appropriate existing account
home. The standalone signup page also redirects an already-authenticated user.

### Release hygiene

The production archive must not contain `.env`, database credentials, local
uploads, `.git`, or development secrets. `.env.example` is the only environment
template. Local demo data belongs only in `scripts/seed-dev.js` and is refused
when `NODE_ENV=production`.

