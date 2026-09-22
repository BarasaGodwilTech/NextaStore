# WIP Log

This is the one live log for ongoing work — append new WIP steps here going forward.
Completed/historical feature changelogs (the old numbered "round N" audits, one-off
feature write-ups, etc.) have been moved to `changelog-archive/` (see its `INDEX.md`)
to keep the project root readable. Anything still genuinely unresolved or unverified —
pulled out of those archived files — is tracked in one place: `OPEN_ITEMS.md`.

## WIP 01 — Run named test suites (read-only)
Date: 2026-09-21

Read `MESSAGES_NOTIFICATIONS_PERF_CHANGELOG.md` first, per instructions. No code was
changed in this step — this was a read-only run of the five suites the changelog names.

### Results

| Suite | Command | Result |
|---|---|---|
| qa:static | `node scripts/qa-static.js` | **PASS** — 141/141 |
| test:messages-perf-browser | `node scripts/messages-perf-browser-test.js` | **PASS** — 23/23 |
| test:messages-flows-browser | `node scripts/messages-flows-browser-test.js` | **PASS** — 39/39 |
| test:notifications-dots-browser | `node scripts/notifications-dots-browser-test.js` | **PASS** — 28/28 |
| test:notifications-filter-browser | `node scripts/notifications-filter-browser-test.js` | **PASS** — 26/26 |

All 5 suites passed, 257/257 checks total. No failures, so there is no failure output to
record.

### Environment notes
- `npm install` could not run (no network access in this environment), so there is no local
  `node_modules` in `nextastore-backend/`. These five suites only need Node's built-in
  `http`/`fs`/`path` modules plus `playwright`, which was available as a global package and
  resolved fine — so they ran unaffected. This does **not** confirm `npm install` itself
  works cleanly here; it just means these particular suites didn't need it.
- Each browser suite spins up its own in-process fake of the relevant backend route(s) on
  localhost — none of them talk to the real `nextastore-backend` server, Postgres, or Redis.
  So this run says nothing new about the real `routes/messages.js` / `routes/notifications.js`
  against a database — the changelog already flags that as unverified (the two manual
  `curl`/Postman checks it lists after deploy are still outstanding).
- `test:integration` (needs Postgres) was correctly not run — it isn't one of the suites
  named for this step.

### Still open
- The changelog's two post-deploy manual checks (`GET .../peek` doesn't mark read;
  `GET /notifications?unread=1` returns only unread) are still unverified against a real DB.
- No code changes made yet — waiting on next step.

## WIP 02 — Review the two unverified backend routes (read-only)
Date: 2026-09-21

### Database availability: NO — checked two ways
- `.env` points `DATABASE_URL` at a remote Railway Postgres host
  (`iriguchi.proxy.rlwy.net:18494`). A raw TCP connection attempt to that host/port timed
  out — this sandbox has no outbound network access, so the real database is unreachable
  regardless of credentials.
- Separately, `npm install` failed earlier (also blocked by the network), so
  `nextastore-backend/` has no `node_modules`. `express`, `@prisma/client`, `cors`, `helmet`,
  `bcryptjs`, and `jsonwebtoken` all fail to resolve. Even with a reachable database,
  `server.js` cannot boot here — the runtime dependencies aren't installed.

So per the instructions, this was a code review instead of a live call. Both files pass
`node --check` (no syntax errors).

### GET /messages/conversations/:id/peek — exists, wired up, looks correct
- `nextastore-backend/src/app.js:149` mounts `messageRoutes` at `/api/messages`; the route
  itself is `router.get('/conversations/:id/peek', requireAuth, conversationGetHandler(true))`
  (`src/routes/messages.js:499`) — full path `GET /api/messages/conversations/:id/peek`,
  matching the changelog.
- It shares one handler, `conversationGetHandler(peekOnly)`, with the normal
  `GET /conversations/:id` route (`:498`, `peekOnly=false`). Authorization
  (`loadConversationForUser`, `:314`) is identical for both — buyer or store-owner only,
  same query either way — so peek doesn't loosen access.
- The read-marking side effect is gated on `peekOnly`: `const markReadPromise = peek ?
  Promise.resolve({ count: 0 }) : prisma.message.updateMany(...)` (`:394`). When `peek` is
  true, the `updateMany` that would stamp the other party's messages `readAt` is skipped
  entirely, and so is the follow-on notification-settling call chained onto it (`:400-409`,
  only runs off the real `updateMany`'s result). So peek returns the thread (messages,
  presence, pagination — same shape as the normal route) without marking anything read, by
  construction, not just by accident of timing.
- Route order (`:498` then `:499`) doesn't matter here — `/conversations/:id` and
  `/conversations/:id/peek` are different path lengths, so Express can't confuse one for the
  other; no shadowing risk.
- Nothing here contradicts the changelog's description. This confirms the code does what it
  claims; it does not confirm the deployed server matches this code, or that Prisma's
  generated client behaves the same against the real schema.

### GET /notifications?unread=1 — exists, wired up, looks correct
- `app.js:150` mounts `notificationRoutes` at `/api/notifications`; the handler is
  `router.get('/', requireAuth, ...)` (`src/routes/notifications.js:34`) — full path
  `GET /api/notifications?unread=1`, matching the changelog.
- `const unreadOnly = req.query.unread === '1';` then
  `where: { userId: req.user.id, ...(unreadOnly ? { readAt: null } : {}) }` (`:36-39`) — with
  `?unread=1` the Prisma query adds `readAt: null` to the `WHERE`, so only rows with a null
  `readAt` are returned; without it (or with any other value), the extra clause is omitted
  and it's the plain newest-30 list. `take: 30` applies in both cases, newest first.
- `unreadCount` and `bellCount` in the response are separate `count()` queries over the
  user's *whole* table (not just the returned page), so they stay meaningful even when more
  than 30 are unread — matches the changelog's "Showing your newest 30 of N unread" behavior.
- This confirms the code does what it claims; same caveat as above — not run against the
  real database or the real Prisma client in this environment.

### Not fixed
Nothing needed fixing — both routes matched the changelog's description on review. No code
was changed in this step.

### Still open
- Both routes remain unverified against a live database / real Prisma client — that needs an
  environment with network access to the Postgres host (or a local Postgres) and
  `npm install` able to reach the registry.

## WIP 03 — Confirm service worker v11 / hard-refresh cleanup, then fix anything failed
Date: 2026-09-21

### Service worker check
- `service-worker.js:19` — `CACHE_VERSION = 'v11'` confirmed in source.
- `js/main.js` is not involved in registration — every page (`index.html`, `login.html`,
  `messages.html`, `dashboard.html`, and 18 others) calls
  `navigator.serviceWorker.register("/service-worker.js")` directly, all pointing at the
  same file — no page is registering a stale worker path.
- Ran `node scripts/push-sw-test.js` (in-process, simulated SW environment): **48/48 passed**,
  including "activate: drops old NextaStore caches, keeps the current one and other apps'
  caches" and "cache version was bumped for the push release".
- Ran `node scripts/push-sw-browser-test.js` (real Chromium via Playwright — registers the
  actual `service-worker.js` at the site root, first seeding a fake leftover
  `nextastore-cache-v10` to prove cleanup): **20/20 passed**, including the exact check asked
  for here — **"activation creates the nextastore-cache-v11 cache and deletes the old
  nextastore-cache-v10 one"** — confirmed true in a real browser, plus "worker registers at
  the site root".
- Conclusion: the service worker registers with cache version v11, and activation (which is
  what a hard refresh triggers — `skipWaiting()` + `clients.claim()` mean it doesn't wait for
  old tabs to close) deletes any stale `nextastore-cache-v10`. Confirmed, nothing to fix.

### Plain list — what passed / failed / fixed (this step + carried over from WIP 01–02)

**Passed:**
- qa:static — 141/141 (WIP 01)
- test:messages-perf-browser — 23/23 (WIP 01)
- test:messages-flows-browser — 39/39 (WIP 01)
- test:notifications-dots-browser — 28/28 (WIP 01)
- test:notifications-filter-browser — 26/26 (WIP 01)
- `GET /api/messages/conversations/:id/peek` — code review, matches changelog (WIP 02)
- `GET /api/notifications?unread=1` — code review, matches changelog (WIP 02)
- push-sw-test.js — 48/48 (WIP 03, new)
- push-sw-browser-test.js — 20/20, including the v11-registers / v10-deleted check (WIP 03, new)

**Failed:** none. Nothing in WIP 01, WIP 02, or this step's service-worker checks failed.

**Fixed:** nothing. There was nothing to fix — every suite passed and both routes already
matched the changelog on review. No code was changed in this step (or in WIP 01/02).

### Still open (unchanged from WIP 02)
- The two message/notification routes are still unverified against a live database — that
  still needs an environment with network access to Postgres (or a local one) and a working
  `npm install`.

## WIP 04 — Header regroup: move account-nav-slot into pf-header-actions

**Task:** The `product-form.html` header (add/edit product page) looked disorganized — the
account avatar/notification bell was stranded in the middle of the bar instead of sitting
with the other right-side controls.

**Confirmed first, on a real render:**
- Built a static harness reproducing the actual `.pf-header` markup with the real
  `css/main.css`, `css/dashboard.css`, `css/product-form.css` (unmodified) and a realistic
  populated `.account-nav-slot` (notification bell + avatar), screenshotted at 390px and a
  desktop width.
- This reproduced the reported bug exactly: `.pf-header` has three top-level flex children
  under `justify-content: space-between` — the back link, the standalone
  `.account-nav-slot`, and `.pf-header-actions` — so the avatar/bell sat alone in the center
  instead of grouping with Delete/Save.
- Also found that `css/dashboard.css` already contained a rule anticipating this fix:
  `.pf-header-actions .account-nav-slot{display:flex}` (line ~1803) — i.e. the CSS was
  already set up for `.account-nav-slot` to live inside `.pf-header-actions`, confirming
  this is the intended two-column pattern (matches `dashboard.html`'s `.top-bar-left` /
  `.top-bar-right`, `messages.html`'s `.messages-topbar`, etc.).

**Fix applied (product-form.html only, header markup only):**
- Moved `<div class="account-nav-slot" data-account-nav></div>` from being a sibling of
  `.pf-header-actions` to being the first child inside `.pf-header-actions`, alongside the
  Delete/Save buttons.
- No CSS changes were needed or made — `css/product-form.css` is byte-identical to WIP 03.
  Verified with a diff against the WIP 03 zip.
- Re-ran the same static-harness screenshot at 390px and desktop after the change: back
  link stays left; bell, avatar, Delete (when visible) and Save now group together on the
  right at both widths, matching the other pages' two-column header pattern.

**Scope check:** only `product-form.html` changed (one HTML edit, 2 lines moved). Nothing
else in `product-form.html`/`product-form.css` was touched. Diffed both files against the
WIP 03 zip to confirm.

**Still open / what to check:**
- This was verified with a static markup harness (real CSS, hand-populated account-nav
  content) rather than a live login, since there's no network access in this environment to
  run the backend + seed data. Worth a quick manual check in the real app (logged in as a
  seller, both mobile and desktop) to confirm nothing about the live JS (e.g.
  `renderAccountNav`'s notification dropdown positioning) behaves differently once it's
  nested inside `.pf-header-actions` instead of being a standalone sibling — the CSS rule
  already assumes this nesting, but it hadn't been exercised with the real markup before.
- Didn't check other pages that might have the same `.account-nav-slot`-as-stray-sibling
  pattern outside the ones this task named (dashboard.html, messages.html, orders.html,
  favorites.html) — those weren't reported as broken and weren't in scope.

## WIP 05 — Header mobile wrapping (product-form.html `.pf-header`) — Part 4, step 2

**Task:** `.pf-header` had no `flex-wrap`, so behaviour on narrow phones (~360-430px) was
undefined. Add proper wrapping/spacing like the other page headers, then verify Add mode and
Edit mode header behave identically. Header only.

**Reproduced first (unmodified CSS, real `main.css`/`dashboard.css`/`mobile.css`/`product-form.css`,
real `product-form.html` markup, static harness):** at 360-430px the "Back to Products" link
wrapped onto two lines, the actions group wrapped internally with Save floating under the
avatar, and Edit mode was a different height to Add mode (199px vs 139px at 360/390).

**Fix (`css/product-form.css` only; `product-form.html` and JS untouched — diffed vs the WIP 04 zip):**
- Base `.pf-header`: added `flex-wrap: wrap` and a row/column gap (same approach as
  `.messages-topbar`); back link `white-space: nowrap; flex-shrink: 0`; `.pf-header-actions`
  gets `margin-left: auto` so a wrapped actions row stays right-aligned.
- New `@media (max-width: 640px)` phone layout, one fixed structure for both modes:
  row 1 = back link (left, 44px min tap height) + bell/avatar (right);
  row 2 = action buttons sharing the full width (Save alone in Add; Delete + Save Changes
  side by side in Edit). Done with `display: contents` on `.pf-header-actions` plus a
  zero-height forced-break `::after`; no markup change.
- 640px chosen because below ~606px Edit mode's full action group can't fit on one wrapped
  line without orphaning Save Changes (seen at 600px during testing).

**Verified (headless Chromium, both modes, widths 320-1280):**
- 360/375/390/414/430/480/560/600/640: header height is 131px in BOTH Add and Edit mode,
  no horizontal overflow, no overlapping items. Back link stays on one line.
- 641-768: Add = single row (79px). Edit wraps to two rows (113px) with the actions
  right-aligned — expected, its action group is wider. >=860: both single row (79px).
- 320: bell/avatar drops to its own row under the back link; still no overlap/overflow.
- "Identical" means same layout, spacing and height on phones. The content still differs
  by design: Edit shows the Delete button and "Save Changes" instead of "Save Product".

**Still open / what to check:**
- Harness used static markup (real CSS, hand-built account-nav with bell + avatar + one
  seller badge) with Font Awesome stubbed (no network) and no login/backend. Please check
  on the live app as a seller at 360-430px: the notification dropdown and account menu
  open correctly from the row-1 slot, and Delete / Save Changes labels fit.
- The existing 560px rule `.pf-header-actions .btn span { display:none }` matches nothing
  (button labels aren't in a `<span>`); left as is, out of scope.
- The pasted prompt also contained the line "improve the ui of this page we can have the
  save/delete below after filling in details". Not done here: this step is header-only.
  That would move Save/Delete out of the header — needs its own step.
- Sticky header is now ~131px tall on phones (was 139-199px). Say if you want it
  non-sticky on mobile.

## WIP 06 — product-form: Save/Delete moved below the form (follow-up to WIP 05)

**Task:** "Improve the UI of this page — have the Save/Delete below, after filling in the
details." (The line that was pasted with WIP 05 but held back because that step was header-only.)
No zip name was given, so `NextaStore_WIP_06_form-actions.zip` follows the existing pattern.

**Changed:**
- `product-form.html`: removed `#deleteBtn` / `#saveBtn` from `.pf-header`; added a
  `.pf-actions` bar as the last item inside `#productForm` (after Photos / Basic Info /
  Pricing / Inventory). Same ids, so `js/product-form.js` needed no change. Save is now a plain
  `type="submit"` inside the form (the `form="productForm"` attribute is no longer needed).
- `css/product-form.css`: new `.pf-actions` (top divider; desktop: Delete left, Save right;
  Add mode = Save right-aligned). At <=560px the buttons are full width, 48px tall, Save on
  top and Delete beneath it. Removed the WIP 05 phone two-row header block (`display: contents`,
  forced break) and the inert `.btn span` rule since the header no longer holds buttons.
  Kept WIP 05's `flex-wrap`, gap and non-wrapping back link.
- Header is now just back link + bell/avatar: 79px tall, one row, at every width 360-1280, in
  both Add and Edit mode (identical).

**Verified (headless Chromium, same static harness as WIP 05):** at 360/390/430/768/1280 in
Add and Edit mode: header 79px, no overflow, Save (and Delete in Edit) sit below the last card
and inside the form. Screenshots checked at 390 and 1280.

**Still open / what to check on the live app:**
- Not exercised with real JS/backend: please add a product and edit one as a seller. Save
  should submit and validate (required name/price), Delete should show the confirm dialog.
- Behaviour change to be aware of: the buttons are now inside the form, so the existing
  `loadProduct()` disables them while an Edit page is loading and re-enables them after.
  Save can't be tapped before the product data arrives.
- The buttons are no longer visible on a long form without scrolling down. If you want a
  sticky bottom bar on phones, that's a follow-up.


## WIP 06a — Emoji / emoji-like glyph inventory audit

**Task:** Inventory-only audit of emoji and emoji-like glyphs across the project. No application code changes.

**Changed:**
- Added `EMOJI_AUDIT.md` with file/line, glyph/source form, surrounding context, location type, proposed Font Awesome 6.5.1 free icon, consistent mappings, category totals, and negative findings.
- Audited HTML, JS, CSS, JSON and backend source, including Unicode escapes, HTML numeric entities, CSS `content`, titles/meta, notification/push text, email-template source, and API/UI messages.
- Flagged the remaining star/rating code in `js/product-detail.js` as legacy/dead rating code without changing it.
- The supplied archive filename says `WIP 05`, but its internal `WIP_LOG.md` already contains completed **WIP 06**. Per the session rule to verify rather than trust filenames, this checkpoint uses **WIP 06a** and leaves earlier numbering unchanged.

**Still open:**
- The actual emoji/icon replacements have **not** been made; that belongs to a later step.
- The flagged rating/star code has **not** been removed or altered.
- No source-code fixes were performed in this WIP.

**Check:**
- Review `EMOJI_AUDIT.md`, especially the proposed mappings: 📦 → `fa-box`, 📍 → `fa-location-dot`, and • → `fa-circle`.
- Confirm the legacy rating/star findings are intentionally handled in a later step.

## WIP 06b — Shopper-page static HTML emoji → Font Awesome (no changes needed)

**Task:** Replace emoji in the static HTML of the shopper-facing pages (index, marketplace,
product-detail, store, store-detail, stores, cart, orders, favorites, following, safety) with
Font Awesome icons per `EMOJI_AUDIT.md`'s mapping.

**Finding — task doesn't apply to these files, verified independently:**
`EMOJI_AUDIT.md` already reports `Static HTML: 0` occurrences and states in its coverage
section that no emoji or emoji-like glyphs were found in static HTML. Per the WIP rules
(treat prior claims as hints to verify, not facts), I independently re-scanned all 11 files
listed above: a full non-ASCII character dump plus targeted emoji-Unicode-range and
HTML-entity searches. The only non-ASCII characters present are em dashes (—), one
non-breaking hyphen (‑), and ellipses (…) — no emoji, no `&#x1F...;`/`&#128...;` entities.

All emoji the audit did find (📦 shared-product, 📍 shared-location, • separators, ★/☆
legacy rating stars) live in `js/product-detail.js`, `js/messages.js`, `js/dashboard.js`,
and `nextastore-backend/src/routes/messages.js` — JS-rendered strings and backend message
text, not static HTML, and not in any of the 11 files this step targets (dashboard.html
isn't even in the shopper-page list).

**Changed:** Nothing. No HTML, CSS, or JS files were modified. The 11 pages already use the
`<i class="fas fa-...">` pattern extensively elsewhere on the page (confirmed via grep), so
if a future step needs to touch the JS-rendered emoji, the existing markup convention is
clear to follow there.

**Still open:**
- The JS-rendered emoji (📦, 📍, • in `js/messages.js`, `js/dashboard.js`,
  `js/product-detail.js`) and the backend copy in `routes/messages.js` are unaddressed —
  those weren't in scope for "static HTML" per this step's own wording, so they're left for
  a later step (e.g. a "JS-rendered" or "backend messages" WIP).
- The legacy/dead star-rating code in `js/product-detail.js` remains flagged but untouched,
  per WIP 06a's note.

**Check:** Confirm whether a follow-up WIP should target the JS-rendered emoji next (messages
share-type labels, dashboard bullet separators) — that's where all 12 audited occurrences
actually live.

## WIP 06c — Seller/auth-page static HTML emoji → Font Awesome (no changes needed)

**Task:** Replace emoji in the static HTML of dashboard, product-form, subscription, admin,
messages, login, signup, forgot-password, verify-email, and onboarding with Font Awesome
icons per `EMOJI_AUDIT.md`'s mapping, matching WIP 06b's markup style and icon choices.

**Finding — task doesn't apply to these files either, verified independently:**
Same check as WIP 06b: a full non-ASCII character dump plus an HTML numeric/hex entity
search across all 10 files listed above. No emoji and no `&#...;` entities in any of them.
The only non-ASCII characters present are en dashes (–), em dashes (—), a middle dot (·),
curly quotes (" "), an ellipsis (…), and one rightward arrow (→) in `onboarding.html` — none
of these are emoji or appear in the audit's mapping table (📦→fa-box, 📍→fa-location-dot,
•→fa-circle, ★/☆→fa-star).

This is consistent with `EMOJI_AUDIT.md`'s finding, which was project-wide, not
page-specific: `Static HTML: 0` occurrences anywhere in the codebase. WIP 06b already
established this for the shopper-facing pages; this step confirms it holds for the
seller/auth pages too. All 12 audited emoji occurrences remain confined to
`js/product-detail.js`, `js/messages.js`, `js/dashboard.js`, and
`nextastore-backend/src/routes/messages.js` — JS-rendered strings and backend message text.

**Changed:** Nothing. No HTML, CSS, or JS files were modified in this WIP.

**Still open:**
- Same as WIP 06b: the JS-rendered emoji (in `js/messages.js`, `js/dashboard.js`,
  `js/product-detail.js`) and the backend copy (`routes/messages.js`) are the only places
  with actual emoji left to address, and neither is "static HTML."
- With both HTML batches (06b, 06c) now confirmed empty of static-HTML emoji, there is no
  remaining static-HTML work under the current audit — any future emoji-replacement step
  should target the JS-rendered/backend occurrences instead, unless a fresh scan turns up
  something the original audit missed.

**Check:** Since two consecutive HTML-focused WIPs have found nothing to change, please
confirm whether the next step should pivot to the JS-rendered/backend emoji, or whether
there's a different set of files/emoji in mind that the audit didn't cover.


## WIP 06d — JS-rendered emoji/glyphs → Font Awesome

**Task:** Read `EMOJI_AUDIT.md` and replace the audited JavaScript-rendered emoji/glyphs, plus any
CSS `content` glyphs listed there. The audit reported 12 target glyph occurrences: product/location
emoji escapes, dashboard bullet separators, and legacy rating stars. It reported no CSS `content`
glyphs.

**Changed:**
- `js/messages.js`: removed the product/location emoji from the plain preview text and added
  `previewHtml()` so conversation-list previews render trusted static `fa-box` /
  `fa-location-dot` icons. The dynamic preview text is passed through `app.escapeHtml()` before
  insertion.
- `js/dashboard.js`: product/order search-result subtitles now use trusted static `fa-circle`
  separators in `subtitleHtml`; dynamic category/customer/price/status values are escaped first.
- `js/product-detail.js`: converted the legacy JS-rendered `★` / `☆` rating output to Font
  Awesome filled/half/empty star icons. The helper clamps the numeric rating to 0–5 before
  generating static icon markup. The existing rating UI was converted rather than left as
  legacy glyph output because this step explicitly targets all audited JS-rendered glyphs.
- `nextastore-backend/src/routes/messages.js`: removed the product/location emoji from backend
  notification preview text. The corresponding client-side conversation preview now supplies
  the visual icon, while notification bodies remain plain text.
- `EMOJI_AUDIT.md`: appended a WIP 06d replacement-status section documenting the conversions
  and validation.
- No CSS changes were needed because the audit found **0 CSS `content` glyphs**.

**Validation:**
- `node --check` passed for `js/messages.js`, `js/dashboard.js`, `js/product-detail.js`,
  and `nextastore-backend/src/routes/messages.js`.
- A project-wide target-glyph scan found no remaining audited `📦`, `📍`, `•`, `★`, or `☆`
  source forms/escapes in JS/CSS/backend source.
- Confirmed the converted icon spots use HTML insertion (`innerHTML` / template markup), not
  `textContent`, so `<i>` is interpreted as an element rather than displayed as raw markup.
- Confirmed dynamic values in the new icon-bearing markup are escaped before insertion; no
  user-supplied value is used as trusted HTML.

**Still open:**
- No audited emoji/glyph replacement remains from `EMOJI_AUDIT.md`.
- Live browser rendering against the full running app was not available in this environment
  because Playwright is not installed in the supplied project/runtime. The source-level
  renderer checks and syntax validation passed.

**Check:**
- In the live app, open a conversation list containing a shared product and shared location,
  use dashboard search for products/orders, and open product reviews/rating breakdowns. Verify
  Font Awesome icons appear visually and no literal `<i ...>` markup is visible.


## WIP 06e — Non-icon spots audit: dialogs, titles/meta, manifest, push text, email

**Task:** Read `EMOJI_AUDIT.md` and audit the requested non-Font-Awesome-renderable locations:
`alert()` / `confirm()`, `document.title`, HTML `<title>` and meta tags, `manifest.json`,
OS push notification text (`service-worker.js` plus backend), and email templates/text.

**Verified against the actual WIP 06d project:**
- **Native `alert()` / `confirm()`:** no application-native `window.alert()` or
  `window.confirm()` calls were found. The application uses its in-site `app.confirm()`
  replacement and its `app.showAlert()` UI instead. The inspected confirmation messages
  contain no emoji. The `alert()` occurrences in test fixtures are security-test payloads,
  not user-facing messages. No dialog redesign was made.
- **`document.title` / HTML `<title>`:** all inspected title strings are plain text with
  no emoji. Dynamic titles in `js/product-detail.js` and `js/store-detail.js` use the
  product/store name plus `NextaStore`; the notification-count prefix in `js/main.js`
  is numeric text only. No changes needed.
- **Meta tags:** inspected page metadata and the backend SEO template contain no emoji in
  titles, descriptions, theme metadata, Open Graph/Twitter metadata, or robots metadata.
  No changes needed.
- **`manifest.json`:** name, short name, description, shortcut names, and icon metadata
  contain no emoji. No changes needed.
- **Push notification text:** `service-worker.js` supplies/limits plain `title` and `body`
  strings and does not add emoji. Backend push creation in `nextastore-backend/src/push.js`
  passes the supplied title/body through unchanged; `nextastore-backend/src/helpers.js`
  generates plain-text notification titles/bodies. No emoji found, so no text changes were
  made. **Notification `tag` / `renotify` logic was not touched.**
- **Email text/templates:** inspected the mailer and all `sendMail()` call sites for reset,
  verification, and administrator password-reset emails. Subjects and text bodies contain
  no emoji. No changes needed.

**Changed:** `WIP_LOG.md` only. No application source changes were necessary for this step.

**Still open:**
- No requested non-icon emoji replacement remains in the audited categories.
- The prior WIP 06d icon conversions remain the only source changes for the audited glyphs.

**Check:**
- The requested categories are source-audited and currently contain no emoji requiring
  removal or rewording. The existing app-level confirmation/alert UI is intentionally left
  unchanged, as requested for message-only native-dialog cases.


## WIP 06f — Emoji verification: full re-scan, qa:static, visual check

**Task:** Re-run the full emoji search across the whole project (HTML, JS, CSS, entities, `\u`
escapes, backend) and confirm nothing remains except approved items; run `qa:static` and fix
anything broken; visually check index/product-detail/cart/orders/dashboard at ~390px and desktop
for icon rendering, text alignment, and layout shift; update `EMOJI_AUDIT.md` with final
per-row status.

**Changed:** `EMOJI_AUDIT.md` only (appended a final WIP 06f verification section). No
application source changes were necessary — the re-scan found nothing left to fix and
`qa:static` passed outright.

**Findings:**
- Full-project scan (HTML/JS/CSS/JSON, emoji Unicode ranges, the five audited glyphs
  `📦`/`📍`/`•`/`★`/`☆` plus their `\u` escapes, and numeric HTML entities) found **zero**
  remaining occurrences in any non-Markdown source file. The only matches were inside
  `EMOJI_AUDIT.md`/`WIP_LOG.md` themselves (expected, since they document history).
- Approved-to-leave items confirmed still present and out of scope: the arrow `→`, curly
  quotes/apostrophes, em/en dashes, ellipses, one middot, and the `©` symbol in
  `js/map-preview.js`.
- `nextastore-backend/scripts/qa-static.js`: **141/141 checks passed**. Nothing to fix.
- Visual check: this sandbox has no network access, so the project's CDN-hosted Font Awesome
  (`cdnjs.cloudflare.com`) doesn't load here. Worked around it for screenshotting only (no
  project files touched) by vendoring a local copy of Font Awesome Free 6.5.1 found already
  present in an unrelated local package, matching the pinned version.
  - `index.html`, `cart.html` (mobile + desktop): rendered live; all icons show, align with
    their text, no layout shift.
  - `product-detail.html`, `orders.html`, `dashboard.html`: rendered their expected fallback
    states in this environment (no product id / no authenticated session / no live DB), so the
    data-dependent icon spots from WIP 06d (star ratings, message-preview icons, dashboard
    search-subtitle separators) were additionally verified by rendering the actual template
    code from `js/product-detail.js`, `js/messages.js`, and `js/dashboard.js` with sample data
    against the project's real CSS. All render correctly and aligned, with no layout shift.

**Still open:**
- Nothing outstanding from the emoji audit/replacement work.
- Live, end-to-end visual confirmation of the data-dependent icon spots (real product ratings,
  real shared-message previews, real dashboard search results) still hasn't been done against a
  running instance with a real database/session, since that wasn't available in this
  environment. The isolated template-level check above is a reasonable substitute but not a
  full substitute for eyeballing the live app.

**Check:**
- If you have a moment against the real deployed/dev environment, open a product page with
  reviews, a conversation with a shared product/location, and the dashboard product/order
  search, and confirm the icons look right there too.



## WIP 07 — Complete remaining improvement prompts

**Task:** Finish the remaining work described in `Pasted markdown.md` rather than continuing one prompt at a time.

**Changed:**
- Verified the existing messaging/notification backend routes and frontend wiring.
- Added a Reply action to `new_message` web push notifications; the action deep-links to the
  exact conversation and requests composer focus.
- Hardened the messages page viewport rules for installed standalone PWAs.
- Confirmed the product-form account slot is already correctly grouped with header actions and
  strengthened narrow-width wrapping.
- Kept the existing Seller Pass redesign and clarified its payment/submit/check flow.
- Added a responsive constraint for the dashboard global-search dropdown on small phones.
- Added `RESPONSIVE_AUDIT_COMPLETED.md` documenting the source-level responsive findings.
- Re-ran `qa:static`: all existing static checks passed before these changes.

**Still open:**
- Real Android/iOS standalone PWA visual verification and authenticated/live-DB tests require a
  running deployment/device and were not available here.
- Browser suites requiring installed dependencies/database could not be completed in this sandbox.

**Check:**
- Test the notification Reply action on Android Chrome and open a real message thread/product page
  in the deployed app at 360–430px and standalone PWA mode.

## WIP 09 — Trial-banner contrast, service worker cache bump, subscription reminder notifications
Date: 2026-09-22

**Task:** Three issues reported from a live dashboard screenshot: the "Your free trial ends in N
days" banner was unreadable (white text on a near-white background), a request to confirm the PWA
actually picks up file changes rather than serving a stale cached copy, and a request for the
seller to be reminded about a lapsing/lapsed trial through an actual notification, not just the
on-page banner.

**Changed:**
- `css/dashboard.css` — added `.welcome-banner--warn` (amber) and `.welcome-banner--danger` (red)
  modifier classes with WCAG-AA-checked contrast (8.57/5.95 and 9.00/6.56), replacing the inline
  `background:#FFF6E5` override that caused the 1.07 contrast ratio.
- `dashboard.html` / `js/dashboard.js` (`renderSubscriptionNudge`) — banner now carries the right
  modifier class for its state (warn while ending soon, danger once expired).
- `service-worker.js` — `CACHE_VERSION` bumped `v11 -> v12` (dashboard CSS/JS changed).
- `nextastore-backend/src/helpers.js` — new `maybeNotifySubscriptionReminder(store)`, reusing the
  existing `subscription` NotificationType; becomes both a bell entry and a web push, ~20h cooldown
  per exact message so it doesn't re-send on every dashboard visit but does send immediately if the
  message itself changes (day count drops, or the trial actually lapses).
- `nextastore-backend/src/routes/store.js` (`GET /`) and `.../routes/subscription.js` (`GET /`) both
  call the helper fire-and-forget after loading the store; the cooldown means calling it from both
  never double-sends.

**Check:** `qa:static` 141/141, `push-sw-test.js` 48/48 (including the v12 bump/activate checks),
`node --check` clean on every edited file, contrast ratios computed (not eyeballed) against WCAG AA.

**Still open:**
- The reminder notification path (`GET /store` / `GET /subscription` → helper → bell row + push)
  is verified by code review and the automated suites above, not by an end-to-end run against a
  real store with `trialEndsAt` inside 3 days — no live database was available here.
- Visual check of the fixed banner in a real browser wasn't possible here (no network access to
  the CDN-hosted Font Awesome this project uses); the WCAG contrast calculation is a reasonable
  stand-in but not a substitute for eyeballing it live.

## WIP 09b — Force already-open/installed PWA sessions onto the new version
Date: 2026-09-22

**Task:** Follow-up to WIP 09: bumping `CACHE_VERSION` makes the *next fresh navigation* pick up
clean assets, but does nothing for a tab or installed PWA window already open when the update
ships — including an installed PWA resumed from the app switcher rather than freshly launched.

**Changed:**
- All 21 pages that register the service worker now also listen for
  `navigator.serviceWorker.addEventListener('controllerchange', ...)` and reload once a *new*
  worker actually takes control.
- Guarded with an `nsHadController` flag read before `register()`: a page with no controller yet
  (brand-new visitor, or the very first install) skips the first `controllerchange` instead of
  reloading, since there's nothing stale to replace. Only a page that was already controlled by an
  older worker and gets handed a genuinely different one triggers the reload. `nsRefreshed` stops a
  second stray event from reloading twice.
- Applied identically to all 21 files (diffed byte-for-byte against each other) rather than
  centralizing in `js/main.js`, since three pages that register the service worker
  (`offline.html`, `safety.html`, `store.html`) don't load `js/main.js` at all.

**Check:** `qa:static` 141/141, `push-sw-test.js` 48/48, the patched block diffed identical across
all 21 files.

**Still open:**
- No live browser/device was available here to watch an actual installed PWA reload on update.
  The `hadController` guard against a false reload on first-ever install is a well-known pattern
  for this exact API, but still worth a real-device check: install the app, ship a change, resume
  the app from the background without force-closing it, confirm it reloads itself once (not zero
  times, not twice).
