# Integration guide (for when you are ready to wire it in)

Nothing in this folder is connected to the project yet. This guide lists every change, in order, with the file it goes in. Each step is small, and the program can stay **closed** (see "Rollout") until you decide to open it.

The folder maps onto the project like this:

| In this folder | Copy to |
|---|---|
| `backend/src/growth/` (whole folder) | `nextastore-backend/src/growth/` |
| `backend/prisma/migrations/20261010090000_growth_program/` | `nextastore-backend/prisma/migrations/` |
| `backend/prisma/growth.schema.prisma.txt` (contents) | paste at the end of `nextastore-backend/prisma/schema.prisma` |
| `backend/scripts/` (`growth-*.js`, `growth-qr-test.py`, `lib/`) | `nextastore-backend/scripts/` |
| `frontend/circle.html`, `crew.html`, `invite.html`, `admin-growth.html`, **`auth-bridge.html`** | project root |
| `frontend/css/growth.css` | `css/` |
| `frontend/js/` (all of it: `growth.js`, `growth-ui.js`, `growth-hosts.js`, `growth-config.js`, `growth-session.js`, `growth-sw.js`, `growth-qr.js`, `growth-kit.js`, `growth-ref.js`, `invite.js`, `growth-invite-widget.js`, `admin-growth.js`) | `js/` |
| **`frontend/assets/growth-brand/`** (logos, favicons, share images; about 1.6 MB) | `assets/growth-brand/` |
| `assistant/` | `ai-assistant/src/knowledge/` (see step 11) |

---

## Backend

### 1. Database
1. Paste `growth.schema.prisma.txt` at the end of `prisma/schema.prisma`.
2. Add `growth` to `enum NotificationType`:
   ```prisma
   enum NotificationType {
     new_order
     new_message
     low_stock
     subscription
     new_product
     store_live
     growth
   }
   ```
3. Copy the migration folder. **Run it on a copy of the real database first**: it was hand-written because `prisma migrate` could not run in the sandbox. It contains three things Prisma cannot express (a partial unique index so one phone is an active lead for one Crew member; a "one open withdrawal per partner" index; two money check constraints). Prisma will report them as drift on `migrate dev`. That is expected; keep them.
4. `npx prisma generate`.

No existing model is edited. The growth tables point at `User`, `Store` and `SubscriptionPayment` by plain id, with no relation fields.

### 2. Admin permissions (`src/middleware.js`)
Add to `ADMIN_PERMISSIONS`:
```js
GROWTH_VIEW: 'growth.view',
GROWTH_REVIEW: 'growth.review',
GROWTH_PAYOUTS: 'growth.payouts',
GROWTH_SETTINGS: 'growth.settings'
```
The role editor lists `Object.values(ADMIN_PERMISSIONS)`, so the new permissions appear there. Then update `scripts/admin-rbac-test.js` and `admin-console-browser-test.js`, which hard-code the permission list. Suggested defaults: Super Admin gets all four; Store Manager gets `growth.view`; create a "Payouts" role with `growth.payouts`; keep `growth.review` and `growth.payouts` on different people.

### 3. Build and mount (`src/app.js`)
```js
const { createGrowth } = require('./growth');
const growth = createGrowth({
    prisma,
    createNotification: helpers.createNotification,
    recordAdminAudit: helpers.recordAdminAudit,
    apiError: utils.apiError,
    savePrivateImage: async (dataUrl, folder) => { /* see step 6 */ }
});
const growthRoutes = growth.routes({ requireAuth, requireAdminPermission, limiter: growthWriteLimiter /* an express-rate-limit instance like your existing ones */ });
app.use('/api/growth', growthRoutes.partner);
app.use('/api/admin/growth', growthRoutes.admin);
```
Also add `'/api/growth'` to the list that gets the 20 MB JSON parser (the `uploadJsonLimiter` line near the top), because the Crew application sends an ID photo. Without it the default 100 KB limit rejects the upload.

**Mount the host router first** (before `express.static`, before your clean-URL middleware, before any `app.get('/circle')` you may have): it serves the two program hosts and the short invite link, and does nothing at all in the default "path" mode other than give the three pages correct link previews.
```js
app.set('trust proxy', 1);                                         // so the router sees the real host and https behind your proxy
app.use(growth.hostRouter({ pagesDir: path.join(__dirname, '..') }));   // pagesDir = the folder that holds circle.html, crew.html, invite.html, auth-bridge.html, js/, assets/
```
Everything it needs it takes from `growth.hosts`, which reads the environment (see **Subdomains** below). With no environment variables set you get exactly the v1 to v3 layout (`/circle`, `/crew`, `/invite` on the main site).

Put the `createGrowth(...)` call in its own small file, `src/growthInstance.js`, exporting the one shared `growth` object. `app.js` and the route files (`auth.js`, `store.js`, `subscription.js`, `admin.js`) all `require('../growthInstance')` from there, which avoids a circular import with `app.js`.

### 4. Hook into the existing flows
Every hook is `growth.hooks.safe.*`: a failure is logged and swallowed, so it can never break a signup or a payment.

**a) Signup** (`routes/auth.js`, `POST /signup`, after `prisma.user.create`):
```js
const store = await prisma.store.findUnique({ where: { ownerId: user.id } });
growth.hooks.safe.onSignup({ user, code: req.body.referralCode, via: req.body.referralVia, ip: req.ip, deviceHash: req.body.deviceHash, phone: '' })
  .then(() => store && growth.hooks.safe.onStoreCreated({ user, store }));
```
Add to `signupSchema` in `validation.js`: `referralCode: z.string().trim().max(24).optional(), referralVia: z.enum(['link','code']).optional(), deviceHash: z.string().max(64).optional()`.

**b) Buyer becomes seller** (`routes/user.js`, `POST /become-seller`, after the store is created): `growth.hooks.safe.onStoreCreated({ user: req.user, store })`.

**c) Store phone saved** (`routes/store.js`, `PUT /`, after the update, when `phoneNumber` changed): `growth.hooks.safe.onStoreCreated({ user: req.user, store: updated })`. It is safe to call repeatedly: it only does something if the user has no referral yet and the phone matches a Crew member's live lead. This is how a Crew member's lead is matched when the owner signs up without a code and fills in their phone during onboarding.

**d) Store goes live** (`routes/store.js`, inside the existing `if (data.isPublished === true && !store.isPublished)` block): `growth.hooks.safe.onStoreLive({ storeId: store.id })`.

**e) Payment submitted** (`routes/subscription.js`, `POST /payments`, after `subscriptionPayment.create`): `growth.hooks.safe.onPaymentSubmitted({ payment, store })`.

**f) Payment approved** (`routes/admin.js`, `PUT /subscription-payments/:id/approve`, after the audit and notification, before `res.json`):
```js
growth.hooks.safe.onPaymentApproved({
    payment, store: { ...payment.store, name: payment.store.name }, adminId: req.user.id, previousPaidUntil: existingPaidUntil
});
```
`existingPaidUntil` already exists in that handler; it lets the renewal bonus know when coverage ended.

**g) Payment rejected** (same file, `.../reject`): `growth.hooks.safe.onPaymentRejected({ payment, store: existing.store })`.

**h) Payment reversed.** There is no "reverse an approved payment" action today. When you add one, call `growth.hooks.safe.onPaymentReversed({ paymentId, adminId: req.user.id, reason })`. That is what takes an earning back. Until then reversals are a manual job: void the held earning in the Review tab, or use "Void".

**i) Admin payment review screen.** Add a small badge using `GET /api/admin/growth/payments/:id/preview`. It returns `{ referred, program, partnerName, decision, reasons[] }`. Show "Referred by Amina (Circle)" and any reasons in red. This is the single most useful fraud control, because it warns the admin **before** they approve.

### 5. Nightly job
`growth.sweep()` releases cleared earnings, lapses stale sign-ups and leads, sends the daily "recruits need you" digest, and freezes unhealthy partners. Run it **every hour** (it is idempotent). Easiest options: `setInterval` in `server.js`, or a cron entry that calls a tiny script. If you run more than one server instance, run it on one of them only.

### 6. Private storage for ID photos (important)
Existing images are saved under a public `/uploads/` path. **Do not use that for Crew members' ID photos.** Pass a `savePrivateImage(dataUrl, folder)` that stores the file outside the public directory (or in a private bucket) and returns an opaque key. Then pass `sendKyc` to `growth.routes({ ..., sendKyc: (req, res, key) => ... })` which streams it to the admin **with a real `Content-Type` (`image/jpeg`, `image/png` or `application/pdf`)**: the admin page fetches it with the sign-in header and shows it in a new tab, and refuses anything that is not an image or PDF. Until both exist, applying as a Crew member returns a clear "uploads are not set up yet" error rather than saving an ID publicly.

### 7. Capture the referral on the signup page
`js/growth-ref.js` does this for you. Add `<script src="js/growth-ref.js"></script>` to the `<head>` of **every public page** (or load it from `main.js`), so a `?ref=CODE` on any URL is remembered for 30 days. On the signup page:

```js
// prefill an optional "Referral code" field and show the code was recognised
const ref = NextaRef.prefill(document.getElementById('referralCode'));   // returns { code, via, at } or null
// when submitting the signup form
const body = { ...fields, referralCode: refInput.value || undefined, referralVia: refInput.value === ref?.code ? 'link' : 'code' };
// after a successful signup
NextaRef.clear();
```
You can also call `GET /api/growth/resolve/CODE` to show "You were invited by Amina" above the form. All storage is wrapped in try/catch, so private browsing never breaks signup.

The shared link is the **invite page**. In subdomain mode it is the short `https://circle.yourdomain.com/i/CODE`; in path mode it is `/invite?ref=CODE`. Both always work (the old long form redirects), it needs no login and no `data-auth-required`. The invite page sends the visitor to **the main site's signup with `?ref=CODE` in the link**, and `growth-ref.js` also keeps the code in a cookie scoped to the parent domain, so the main-site signup page sees it even if the person types the address by hand later. **`growth-ref.js` must be loaded on the main site's signup page**, as above; that is the only thing the subdomains rely on the main site for here.

### 8. Optional but recommended: capture the payer's number
The strongest self-referral check ("the partner paid from their own mobile money") needs the paying number. Add an optional `payerPhone` field to `SubscriptionPayment` and the payment form, and the risk engine uses it automatically (`payment.payerPhone`). The checks work without it, just less sharply.

### 8b. Replace the fee estimate with the real tariff
`PAYOUT_FEE` in `rules.js` holds a **planning estimate** of the mobile money fee NextaStore pays on a payout. It is not the tariff. Check the current MTN and Airtel business tariffs, correct the table, and then run `growth-economics.js`. The admin also enters the real fee on every payout, and the Economics tab prefers that.

## Frontend

### 9. Pages and navigation
* Copy the five HTML files, `growth.css`, every script in `frontend/js/`, and `assets/growth-brand/` (see the table at the top).
* In `js/auth.js`: add `'/admin-growth'` to `ADMIN_ONLY_PAGES`. `/circle` and `/crew` are open to any signed-in user, and `/invite` is public, so they need no entry. `npm run qa:static` checks the lists against the `data-*-required` attributes.
* Confirm the clean-URL setup serves `/admin-growth` (the host router serves `/circle`, `/crew`, `/invite`, `/i/CODE` and `/auth-bridge` itself).
* Add entry points: an "Earn with NextaStore" link in the account menu (`/circle`), a "Join the Crew" link in the footer or about page, and a link from the admin sidebar to `/admin-growth`.
* **Seller dashboard widget:** place `<div data-growth-invite></div>` where you want the card, and load `growth.css`, `growth-hosts.js`, `growth-ui.js`, `growth-qr.js`, `growth-kit.js` and `growth-invite-widget.js` on that page (in that order). The card links to circle./crew. by itself, using the host settings the server returns from `/api/growth/rules`. It shows "Get my invite code" to non-members and the code, share buttons and what needs attention to members, and hides itself if anything fails.
* Bump the main site's service worker cache version if it precaches page shells. (The program subdomains have their own small worker, `growth-sw.js`, served at `/sw.js` on those hosts only.)
* Add the `growth` notification type to the bell's icon mapping in `main.js`. Until then it falls back to the default icon.
* **No external service is needed for QR codes.** `growth-qr.js` generates them on the phone, so they work with no data. Icons use the Font Awesome you already load.

### 10. Nice touches for later
A "Referred by" line on the admin payment row; a printable A5 flyer page using the same card; local-language pitch cards (need a native reviewer); Seller Pass credit as a reward option.

## Tests and checks
```
node  nextastore-backend/scripts/growth-test.js                  # pure logic: rates, margin guard, clock, limits, fraud signals (100)
node  nextastore-backend/scripts/growth-flow-test.js             # whole stories on an in-memory database stand-in (83)
node  nextastore-backend/scripts/growth-hosts-test.js            # subdomain logic, redirect safety, CORS, brand-file guards, server/browser agreement (44)
python3 nextastore-backend/scripts/growth-qr-test.py             # decodes the offline QR codes with OpenCV (8)
node  nextastore-backend/scripts/growth-economics.js             # prints what the program costs, from rules.js
NODE_PATH=$(npm root -g) node nextastore-backend/scripts/growth-browser-test.js              # real Chromium, path mode (58)
NODE_PATH=$(npm root -g) node nextastore-backend/scripts/growth-subdomain-browser-test.js    # real Chromium, three real hosts (64)
```
The first, second, third and fifth need no install and no database. The QR test needs `pip install opencv-python numpy`. The two **browser tests** need Playwright with Chromium (`npm i -g playwright && npx playwright install chromium`). Set `PROJECT_DIR=.` to serve **your real site files** (your real `main.js`); without it they use a small bundled stand-in (`scripts/lib/stub-site/`) so they also run anywhere. Add them to `package.json` as `test:growth`, `test:growth-flow`, `test:growth-hosts`, `test:growth-qr`, `test:growth-browser` and `test:growth-subdomains`.

**Still needs a live environment**, the same honest caveat as the rest of `OPEN_ITEMS.md`: the migration on real Postgres (and Prisma-specific behaviour such as the partial unique indexes and real transactions); one real run through signup, store launch, a payment, approval, clearing, a withdrawal and a payout with real MTN/Airtel; the ID upload and private storage; and the hourly sweep. The browser test fakes the rest of your API (login, stores, messages) just enough for the pages to load.

## Subdomains: circle.yourdomain.com and crew.yourdomain.com

**One app, one API, three host names.** The pages move to their own addresses; nothing else about the backend changes. It is off until you switch it on, so you can deploy first and switch later.

### A. What you set
1. **DNS**: add `circle` and `crew` records pointing where the main site points (an A/AAAA record, or a CNAME to the same target).
2. **Certificates**: the two new host names need https. A wildcard certificate for `*.yourdomain.com` is simplest; otherwise add both names to the existing one. (The service worker and "install as app" refuse to work without https.)
3. **Proxy**: make sure your reverse proxy forwards the **`Host` header** untouched and that requests for all three names reach the same Node app. Nginx: `proxy_set_header Host $host; proxy_set_header X-Forwarded-Proto $scheme;`, and `server_name yourdomain.com circle.yourdomain.com crew.yourdomain.com;`. Caddy: list the three names in one site block. Express: `app.set('trust proxy', 1)`.
4. **Environment variables** for the Node app:
```
GROWTH_MODE=subdomain
GROWTH_ROOT_DOMAIN=yourdomain.com          # main = https://yourdomain.com, circle. and crew. are derived
# only if the main site is NOT the bare root domain, or for local work:
# MAIN_ORIGIN=https://www.yourdomain.com
# CIRCLE_ORIGIN=http://circle.localhost:4000   CREW_ORIGIN=http://crew.localhost:4000   MAIN_ORIGIN=http://localhost:4000
```
The server refuses to start in subdomain mode with a half-written setup (it names what is missing). Switch it off again by removing `GROWTH_MODE`.

### B. What happens then
| Request | Result |
|---|---|
| `circle.` or `crew.` host, `/` | the Circle or Crew dashboard |
| `circle.` host, `/i/CODE` or `/invite?ref=CODE` | the invite page (the one shared link host for everyone; the same page on `crew.` redirects here) |
| `circle.` / `crew.` host, `/api/*`, `/css`, `/js`, `/assets`, fonts, images | handled by your normal API and static files |
| `circle.` / `crew.` host, `/sw.js`, `/manifest.json`, `/favicon.ico` | this program's own worker, manifest and icon (so Crew installs as its own app with its own icon) |
| `circle.` / `crew.` host, **anything else** (`/login`, `/marketplace`, `/admin`...) | redirected to the same path on the main site |
| main host, `/circle`, `/crew`, `/invite`, `/i/CODE` | redirected to the right subdomain (links and printed QR codes keep working) |
| main host, `/auth-bridge` | the session hand-off page, frameable only by the two program hosts |

The admin console (`/admin-growth`) deliberately **stays on the main site**: admin accounts and permissions live there, and a money console should not be one more public host.

### C. Signing in across hosts (read this: it is the one real design decision)
The site keeps the sign-in token in **localStorage**, which is private to one address, so a person signed in on `yourdomain.com` is a stranger on `circle.yourdomain.com`. v4 hands the session over safely, with no change to `main.js`:
1. `growth-session.js` runs first on circle./crew.; with no token it sends the browser to `yourdomain.com/auth-bridge?to=<the page>`.
2. The bridge page reads the main site's token and sends the browser back to `<the page>#nxs=<session>`. A `#fragment` is never sent to a server. The script stores it and removes it from the address bar. With no session on the main site, the bridge sends the person to `/login?next=<the page>`.
3. After the page loads, a hidden frame asks the bridge "same session?". Signed out on the main site, or switched to another account? The program page follows (so nobody stays signed in as the wrong person).

Safety properties (all covered by tests): the bridge only talks to the two origins **the server** wrote into the page (never to anything in the address), so it cannot hand a sign-in to a look-alike host; the bridge cannot be framed by other sites; the token never stays in the address bar; a damaged hand-over cannot cause an endless redirect loop.
Things to know: (a) if your login page does not honour a `next` parameter, a person who had to log in lands where login normally sends them and taps Circle again, which then works at once; (b) the **long-term** fix is a session cookie scoped to `.yourdomain.com` (then none of this is needed); (c) this relies on circle./crew. being the same *site* as the main host (same registrable domain), which they are.

### D. The API
If your frontend calls `/api` on the **same host as the page** (the usual setup), the same Express app already answers on circle. and crew. and nothing is needed. If the API is on **another** host (for example `api.yourdomain.com`), the router answers CORS for exactly the three growth origins (it echoes the origin, never `*`); if you already use the `cors` package, add the two origins there instead and pass `apiCors: false` to `hostRouter`.

### E. What changes for the pages
* Pages use absolute paths (`/css/...`, `/js/...`) so they work at `/i/CODE`.
* Links to main-site pages (Marketplace, Messages, Terms, the account menu) are rewritten to the main site automatically, including links your `main.js` adds later.
* The program subdomains do **not** load `push.js`, `push-prompt.js` or `presence.js`: a push subscription belongs to one origin, and a second worker on the same scope would fight the main site's. Members keep getting push notifications through the main site.
* The notification bell on the main site links to circle./crew. by full address.
* `growth-ref.js` stores the referral in localStorage **and** a cookie on `.yourdomain.com`, so a code picked up on `circle.` is still known on the main-site signup page.

### F. Check it
```
NODE_PATH=$(npm root -g) node scripts/growth-subdomain-browser-test.js
```
runs three real host names in real Chromium. Then by hand: sign in on the main site, open `circle.yourdomain.com`; sign out on the main site and reload Circle; open a Crew invite link in a private window and complete signup; on a phone, add Crew to the home screen, switch on airplane mode and open it.

## Rollout (suggested)
1. Deploy everything with both programs **closed** (`GrowthSettings`: circleOpen and crewOpen false, through Campaigns > Program settings). Hooks run but nobody can join, so nothing can go wrong.
2. Open **Circle** to staff and friends. Walk the whole path once with real MoMo and a real approval.
3. Open **Crew** to 3 to 5 people you know. Hand-approve, watch the Review and Flags tabs for two weeks.
4. Tune `rules.js` from real numbers, then open wider.

## Nexi (the assistant)
### 11. Knowledge
Done in round 6: the Circle and Crew knowledge is the `growth_*` entries in `ai-assistant/src/knowledge/faq-instant.json` (see `10_SCOUT_TO_CREW_INTERNAL_RENAME.md`, section "Nexi"). The answers deliberately contain **no percentages or amounts**: those are proposals and will change. Point the assistant at `/circle` and `/crew` for current numbers, or add them to `assistantFacts.js` / `factsValues.js` so Nexi follows `rules.js` automatically, as it does for the Seller Pass price today.
