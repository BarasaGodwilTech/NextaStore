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

## WIP 10 — Retire product ratings/reviews (buyer-seller connection model)
Date: 2026-09-22

**Task:** First slice of a larger ask: since NextaStore only connects a buyer and a seller
(fulfillment happens directly between them, off-platform), a star rating/review count isn't
a verifiable trust signal — the same reasoning that already retired `Store.rating` in
migration `20260915180000_seller_badge_commitment`. This step removes the matching
**product**-level rating/review feature. Still queued from the same request: removing the
public "completed orders" counts, simplifying the seller's order-status options, and building
the buyer cancellation flow (grace period, reason picker, anti-abuse limits) — see
`OPEN_ITEMS.md`.

**Found first:** the on-page review UI in `js/product-detail.js` (write-review modal, star
picker, review list, rating breakdown) turned out to be **100% dead code already** —
`product-detail.html` has no matching `reviewModal`/`reviewForm`/`ratingInput`/etc. elements
at all (the tabs are just Description + Shipping & Returns), and `renderReviews()` /
`renderRatingBreakdown()` were never even called from anywhere. This matches WIP 06a's
earlier flag of "legacy/dead rating code" — it's now actually removed rather than just noted.

**Changed:**
- `nextastore-backend/prisma/schema.prisma` — dropped the `Review` model, `Product.rating`,
  `Product.reviews`, and the `User.reviews` / `Product.reviewEntries` relations.
- New migration `20260922090000_retire_product_ratings` — drops the `Review` table and the
  two `Product` columns (no index touches either column, confirmed before writing it).
- `nextastore-backend/src/routes/reviews.js` deleted; unmounted from `app.js`; `reviewSchema`
  removed from `validation.js`. Confirmed zero remaining references anywhere in `src/`.
- `js/product-detail.js` — removed the whole dead feature: the `writeReviewBtn`/`reviewForm`/
  `ratingInput` listeners, `openReviewModal`, `updateRatingInput`, `submitReview`,
  `renderStars`, `ratingStarsHtml`, `renderRatingBreakdown`, `renderReviews`,
  `updateRatingDisplays`, `loadReviews`, and the `this.userRating` state. Tidied two stale doc
  comments that still mentioned reviews (`resumePendingAction`, `js/main.js`'s `requireLogin`
  gate).
- CSS cleanup across `css/product-detail.css`, `css/marketplace.css`, `css/store.css`,
  `css/store-detail.css`, `css/dashboard.css` — removed every rating/review rule confirmed
  unused in any HTML/JS (`.reviews-summary`, `.rating-bar*`, `.review-item*`, `.rating-input*`,
  `.product-rating`, the dead `.store-rating-line`/`.rating-value` pair in
  `store-detail.css`). Kept `.store-mini-rating` (seller badges container) and
  `.rating-count` (dashboard follower count) — both are real classes still in active use for
  unrelated features, just with legacy names.
- `nextastore-backend/scripts/seed-dev.js`, `notify-followers-test.js`, and the `?mock=1`
  demo-only layer `js/api.js` — stripped `rating`/`reviews` fields from demo product data so
  they match the new schema/shape.
- `nextastore-backend/scripts/qa-static.js` — added a check (mirroring the existing
  Store-level one at line 112) enforcing that the Review model, route, schema fields, and UI
  all stay retired together.

**Verified:** `node --check` clean on every edited JS file. `qa:static` — **142/142** (141
existing + 1 new). Full project-wide re-grep for `rating`/`review` afterward found nothing
left except: the in-use `.store-mini-rating`/`.rating-count` classes noted above, unrelated
features that happen to share the word ("Review & Launch" onboarding step, cart's "Review your
items" heading, admin order-report moderation, code-review-style comments), and this
changelog/schema comments explaining the retirement itself.

**Still open (unchanged from before this step, tracked in `OPEN_ITEMS.md`):**
- Public "completed orders" trust counts (`completedOrderCount` in `routes/store.js`,
  `js/stores.js`, `js/store-detail.js`) — same rationale as ratings, not yet removed.
- Seller order-management simplification (the seller's dashboard order-status dropdown
  currently allows jumping to any of pending/processing/shipped/delivered/cancelled — a
  buyer/seller-agree-then-seller-handles-the-rest model calls for fewer, clearer options).
- Buyer cancellation flow: short grace period, a reason-template picker + free-text details
  sent to the seller, and an anti-abuse limit so a buyer can't cycle place-then-cancel
  indefinitely. Design fully scoped (grace-period window, `cancelReason`/`cancelDetails`/
  `cancelInitiator` fields, a rolling-count abuse check, a new `order_cancelled` notification
  type) but no code written yet.

## WIP 11 — Completed-orders counts removed, seller order actions simplified, buyer cancellation built
Date: 2026-09-22

**Task:** The three items left queued from WIP 10's original ask, all under the same
buyer-and-seller-connect-directly reasoning: NextaStore doesn't control what happens after
an order is placed, so it shouldn't display trust signals it can't verify, and the seller's
order tooling shouldn't pretend to be a manual fulfillment tracker it was never meant to be.

**1. Public "completed orders" counts — removed.**
- `nextastore-backend/src/routes/store.js` — dropped the `completedOrderCount` computation
  (an `order.groupBy`/`order.count` on `status: 'delivered'`) from the store directory listing,
  `/store/public/:idOrSlug`, and `/store/public`.
- `js/stores.js` (directory cards) and `js/store-detail.js` (store info card) — removed the
  "N completed" chip; `js/store-detail.js`'s surrounding comment updated to explain why.
- Confirmed no remaining references anywhere (`grep -rn completedOrderCount` across the whole
  project, HTML and JS, comes back empty apart from the qa-static check that guards it).

**2. Seller order actions — simplified.**
- `js/dashboard.js` — replaced the any-status `<select>` (pending/processing/shipped/
  delivered/cancelled, freely jumpable) with a status badge plus one or two contextual
  buttons: pending → **Confirm** / **Cancel**; processing → **Mark completed** / **Cancel**;
  legacy `shipped` orders → **Mark completed** only. `updateOrderStatus` now always repaints
  the row afterward (success or failure) so the button set stays in sync with the real status.
  Cancelling asks for a browser confirm() first, since there's no longer a "revert the select"
  undo path.
- `nextastore-backend/src/routes/orders.js` — the status transition graph no longer routes a
  *new* transition through `shipped` (`processing` now goes straight to `['delivered',
  'cancelled']`); `shipped: ['delivered']` is kept only so any order that already reached that
  state before this change can still be closed out.
- `css/dashboard.css` — new `.order-status-cell` layout (badge + buttons, wraps on narrow
  screens) replacing the old `.order-status-select` mobile sizing rule; buttons keep the
  44px mobile touch-target convention used elsewhere in the dashboard.

**3. Buyer order cancellation — built.**
- New migration `20260922120000_buyer_order_cancellation` — adds `cancelledAt`/`cancelReason`/
  `cancelDetails`/`cancelInitiator` to `Order`, plus an index on
  `(buyerId, cancelInitiator, cancelledAt)` for the abuse-count query. Separate from the
  existing `flaggedAt`/`flagReason` report pair.
- `nextastore-backend/src/validation.js` — `orderCancelSchema`: `reason` is a closed enum
  (`changed_mind` / `wrong_item` / `duplicate_order` / `found_elsewhere` / `other`), `details`
  is always required (min 5 chars) alongside it, even for `other`.
- `nextastore-backend/src/routes/orders.js` — new `POST /orders/:id/cancel` (buyer-only,
  `requireAuth`, no `requireSeller`):
  - Only orders in `pending`/`processing` are eligible; already-`cancelled` orders are
    rejected outright.
  - **Grace period:** 30 minutes from `createdAt` (`CANCEL_GRACE_PERIOD_MS`) — past that, the
    error message points the buyer at messaging the seller instead.
  - **Anti-abuse:** counts the buyer's own `cancelInitiator: 'buyer'` cancellations in the
    last 30 rolling days (`CANCEL_ABUSE_WINDOW_MS`); at 3 (`CANCEL_ABUSE_LIMIT`) or more,
    further self-service cancels are blocked (429) with the same "message the seller" fallback.
    A seller-initiated cancel via `PUT /:id/status` never counts toward this, since
    `cancelInitiator` is only ever set to `'buyer'` on this endpoint.
  - Restocks items using the identical stock-return logic as the seller's own cancel path.
  - Notifies the store owner (`type: 'order_cancelled'`) with the reason label + the buyer's
    own details text, linking to `dashboard.html#orders`.
- `js/orders.js` (buyer's own orders page) — `canSelfCancel(order)` mirrors the grace-period
  window client-side (only to decide whether to show the button; the server re-checks
  everything authoritatively). The order-detail modal gets a **Cancel order** button when
  eligible, opening a second small modal with the reason picker (`<select>`) and a required
  details `<textarea>`; submitting posts to the new endpoint, closes both modals on success,
  and reloads the buyer's order list. An already-buyer-cancelled order shows an inline note
  in its detail view with the reason/details instead of the cancel button.
- `css/messages.css` — small `.order-cancel-note` style for that inline note (orders.html
  loads messages.css for its shared order-detail-modal styling, not dashboard.css).

**Verified:** `node --check` clean on every file touched (`js/orders.js`, `js/dashboard.js`,
`js/stores.js`, `js/store-detail.js`, `nextastore-backend/src/routes/orders.js`,
`nextastore-backend/src/routes/store.js`, `nextastore-backend/src/validation.js`,
`nextastore-backend/scripts/qa-static.js`). `qa:static` — **145/145** (144 existing + 1 new
check per item, covering all three pieces above). Project-wide re-grep for
`completedOrderCount`/`order-status-select` afterward found nothing left outside the
qa-static checks that guard their absence.

**Still open, not built here:**
- No live Postgres database was available in this sandbox — the new migration has not been
  run with `prisma migrate deploy`, so it's unverified against a real database (same caveat
  as every other migration in this project's `OPEN_ITEMS.md`).
- No browser was available either — the seller's new Confirm/Mark completed/Cancel buttons
  and the buyer's cancel-reason modal are code-reviewed and `node --check`-clean, but never
  clicked through in an actual browser.
- The other items already listed in `OPEN_ITEMS.md` (push icon/badge differentiation, seller
  payment settings still hardcoded, notifications dropdown 10-item cap, admin users table,
  presence part 2c, the broader responsive audit, the dashboard UX pass) are unchanged by
  this round.

## WIP 12 — Push notification icon/badge differentiation
Date: 2026-09-22

**Task:** First of the "not actually built yet" open items: `service-worker.js` used one
shared `PUSH_ICON`/`PUSH_BADGE` pair for every push, so a new order and a new message looked
identical in the OS notification tray until read.

**Design decision:** only the **badge** (the small monochrome glyph Android draws from the
alpha channel into the status bar) is differentiated by type. The large **icon** stays the
NextaStore brand mark for every push — it's the notification's identity, not a category
signal, and Android mostly doesn't show it at all (only the badge appears in the status bar).

**Changed:**
- New badge assets, `assets/brand/png/badge/{new_message,new_order,low_stock,
  order_cancelled,new_product,subscription}.png` — 96x96, white glyph on a transparent
  background, generated to match the weight/style of the existing `badge-96.png` "N" mark
  (speech bubble, shopping bag, warning triangle, no-entry circle, price tag, credit card).
  Checked legible at realistic 24px status-bar size, not just at full size.
- `service-worker.js` — added `PUSH_BADGES_BY_TYPE` (a `type → asset path` map) and
  `pushBadgeFor(type)`; the `push` handler now calls it instead of using the single
  `PUSH_BADGE` constant directly. Any type not in the map (`general`, `test`, or anything
  added server-side before its badge is) falls back to the existing plain "N" badge, so
  nothing can end up with a missing asset.
- `nextastore-backend/scripts/push-sw-test.js` — updated the one assertion that hardcoded
  the old shared badge, added a dedicated block firing all six known types plus
  general/test/unrecognized ones and asserting each known type's badge is distinct and
  correct and every fallback case still lands on the plain badge, and extended the
  asset-exists check to all six new files.
- `nextastore-backend/scripts/push-sw-browser-test.js` — same fix to its one hardcoded
  assertion, plus a same-shape real-Chromium block (fires all six types, confirms distinct
  real badge URLs that actually serve PNGs) and an unrecognized-type fallback check. Not run
  here (needs Playwright + a real browser, same as everything else in this file).
- `nextastore-backend/scripts/qa-static.js` — new check confirming all six types are wired
  to their own asset in the service worker, all six files exist on disk, and the fallback
  path is present.

**Verified:** `node --check` clean on every touched file. `node scripts/push-sw-test.js` —
**52/52** (was 50, +2 new checks; this suite runs the real service worker in a Node VM
sandbox, no browser needed). `qa:static` — **146/146** (145 + 1 new).

**Still open, not verified here:** `push-sw-browser-test.js`'s new checks (same as everything
else that needs Playwright/Chromium — see `OPEN_ITEMS.md`). No real device has seen these
badges render in an actual Android status bar.

## WIP 13 — Seller-side payment settings: onboarding wired to the live catalog
Date: 2026-09-22

**Task:** Second of the "not actually built yet" open items. `OPEN_ITEMS.md` pointed at
`js/store-builder.js` and `dashboard.js`'s payment-badge summary (~line 387–390), but
`store-builder.js` no longer exists — payments moved into `onboarding.js`'s step 3 when the
store builder was folded into store settings. On inspection, `dashboard.js`'s payment
rendering (`getPaymentMethods()` / `renderPaymentOptions()` / `renderPaymentBadges()`) was
**already** fetching from `/payments/methods` dynamically — that half of the open item looks
stale, nothing changed there. The real hardcoding was `onboarding.html`'s three fixed
MTN/Airtel/card checkboxes and the matching fixed lists in `onboarding.js`.

**Changed:**
- `onboarding.html` — the three hardcoded `<label class="ob-pay-option">` blocks (IDs
  `obPayMtn`/`obPayAirtel`/`obPayCard`) replaced with an empty `<div id="obPayList">`
  the wizard populates at runtime.
- `js/onboarding.js`:
  - New `loadPaymentMethods()` — fetches `GET /payments/methods`, stores the result in
    `this.paymentMethods`, then calls `renderPaymentOptions()`. Run via `Promise.all(...)`
    alongside the existing `loadExistingStore()` in `init()` so neither blocks the other;
    each calls `renderPaymentOptions()`/`populateFields()` on its own completion, so whichever
    resolves last leaves the final correct state regardless of fetch order.
  - New `renderPaymentOptions()` — builds the step-3 checkbox list from `this.paymentMethods`
    instead of three fixed IDs, checked state read from `this.store.payments[code]`, rebinds
    its own change listeners each render. A small `OB_PAY_BRAND_ICON_CLASS` map keeps the
    existing brand-colored icon chip for `mtnMomo`/`airtelMoney`/`card` (cosmetic only); any
    other catalog code falls back to the existing neutral `.ob-pay-icon` style rather than
    erroring or looking broken.
  - `populateFields()` now calls `renderPaymentOptions()` instead of setting three checkbox
    `.checked` properties directly.
  - `setupEvents()` no longer wires the three fixed checkbox IDs — `renderPaymentOptions()`
    binds its own listeners each time it rebuilds the list.
  - `renderReview()`'s payment chips (step 4) now filter `this.paymentMethods` by
    `this.store.payments`, replacing the old hardcoded three-entry array.
  - Left `this.store.payments`'s in-memory default (`{ mtnMomo: true, airtelMoney: true, card:
    false }`) unchanged — it mirrors the Prisma `Store.payments` column default and is only
    the pre-check state shown before any fetch resolves, not part of the rendering bug.
- `nextastore-backend/scripts/qa-static.js` — new block: confirms the three old IDs are gone
  from `onboarding.html` and `#obPayList` exists; confirms `onboarding.js` fetches the catalog
  and renders from `this.paymentMethods`; confirms the parallel `Promise.all` fetch; confirms
  an unrecognized code still renders via the fallback; confirms the review chips are built
  from the catalog, not the old hardcoded array.

**Verified:** `node --check` clean on `js/onboarding.js` and `qa-static.js`. `qa:static` —
**151/151** (146 + 5 new). Project-wide re-grep for `obPayMtn`/`obPayAirtel`/`obPayCard`
afterward found nothing left outside the qa-static check that guards their absence.

**Still open, not verified here:** no live Postgres or browser in this sandbox, so this was
never clicked through — an admin adding/removing a method in `/admin` and then reloading
onboarding to confirm step 3 and the review chips pick it up is unverified in practice, only
code-reviewed and statically checked (moved to `OPEN_ITEMS.md`'s "needs a live environment"
list accordingly).

## WIP 16 (batch 4) — Auth page redesign, push account name, store-live notification
Date: 2026-09-24

**Task:** Continue the WIP 14–16 login/signup/onboarding overhaul. Audit first: the Ugandan example
names, nextastores.com domain references, URL-vs-name edit nudge, compulsory description/phone/location
and "show my phone" choice were already in place from earlier batches, so nothing was redone.

**Changed:**
- `css/auth.css` (rewritten), `login.html`, `signup.html`, `forgot-password.html` — market-stall awning
  brand panel (sticky, desktop) with a storefront showcase card (UGX prices, MTN MoMo/Airtel chips,
  one-shot "New order" toast); on <=960px the panel is hidden and the awning becomes a strip above the
  form. Breadcrumb bar removed from these pages; "Back to home / Back to sign in" link added. Taller
  inputs, brand-green focus ring, 44px password toggle, 16px inputs on phones, compact Shop/Sell cards
  side by side on small phones. Signup: heading/sub-copy/button follow Shop vs Sell, password strength
  meter (a hint; the 8-char minimum is still the only rule), and the button's cached label is reset on
  account-type change. Checked in real Chromium at 1440, 390 and 360px: no horizontal overflow.
- `nextastore-backend/src/push.js` — payload now `{ type, title, body, link, account }`; `account` is
  the recipient's name (whitespace-collapsed, capped at 32 chars), fetched in its own try/catch so a
  failed lookup sends the push without it.
- `service-worker.js` — prints "Account: <name>" as the last line of the body (name capped at 40);
  payloads without `account` render as before. Cache bumped v12 -> v13.
- `prisma/schema.prisma` + migration `20260924090000_store_live_notification` — new `store_live`
  NotificationType. `routes/store.js` PUT / creates it (bell + push) only when isPublished goes
  false -> true. `js/main.js` maps it to `fa-store`; no dedicated push badge yet (falls back to "N").
- Tests: `push-backend-test.js` (+ user stub, account / lookup-failure / long-name checks) and
  `push-sw-test.js` (+5 account-line checks); `qa-static.js` +10 checks.

**Not verified:** the migration was never run against Postgres; icons could not be seen in the
screenshots (Font Awesome CDN is blocked in the sandbox); the Terms of Service / Privacy Policy links on
signup still point to `#` (no such pages exist yet).

**Still open from the WIP 14 ask (not started this batch):** onboarding link shown as
`nextastores.com/s/<slug>`; add-a-product-before-launch prompt (+ product-form `?from=onboarding`
return); onboarding big-screen layout (sticky live-preview rail); preview map under the onboarding
location card; more visible "you're live" moment on the dashboard.

## WIP 16 (batch 5) — PARTIAL: onboarding rebuilt; product form, backend guard and dashboard still to do
Date: 2026-09-24

**Done (onboarding.html / js / css):**
- **Link display.** New `app.storeAddress(slug, publicUrl)` in `js/main.js`: shows `nextastores.com/s/<slug>`
  (host follows the backend `publicUrl`, so it follows SITE_URL to nextastore.ug later; localhost/LAN/tunnel
  hosts are never shown), Copy uses the real `shareUrl`, Preview opens the styled in-app store page. The prefix
  is now always visible (stacks above the input under 360px instead of being hidden).
- **Slug logic.** Fixed: typed hyphens were stripped on every keystroke; emptying the name forced `my-store`;
  the empty nudge box showed on every load (`hidden` lost to `display:flex`). Now: apostrophes drop
  (Amina's -> aminas), editing the link stops name-based suggestions, emptying it and leaving resumes them,
  rename-after-edit shows the keep/update nudge, min 3 characters, server "already taken" shows inline, and
  changing the link of an already-live store asks for confirmation.
- **Location.** Label "Location (city or district)"; card says City or District; small map under it (shaded
  area when only a city/district is chosen, pin when an exact pin is set); in-page guidance on dropping a pin.
  `map-picker.js` exports `kind()`, and Fort Portal now reads with a space. Phone needs >= 9 digits.
- **Wide screens (>=1100px).** Two columns; sticky live-preview rail (storefront card + "before you launch"
  checklist) that updates as you type. In-card previews are hidden there to avoid repeating it.
- **First product before launch.** Step 4 checks `GET /products?limit=1`; with none, shows an "Add your first
  product" card and the primary button becomes that action (-> `product-form.html?from=onboarding`); with some,
  it becomes Launch store. `?step=4` is honoured on return (only if the basics are saved).

**Verified in real Chromium (Playwright, stubbed API, 1440px and 390px):** no page errors, no horizontal
overflow; typed hyphenated link; rename nudge -> update/keep; empty-and-leave resumes suggestions; validation
shows all missing fields at once; location saved (city label + map); steps 1->4 save; product gate empty vs
ready and the button label in each. `qa:static` 161/161 (one assertion updated for the third parallel fetch).

**NOT done yet, so the flow is currently broken at one point:** the "Add your first product" button links to
`product-form.html?from=onboarding`, but product-form.js does not read `from` yet, so after saving it returns
to the dashboard, not `onboarding.html?step=4`. Also not built: the server-side guard on `isPublished:true`
with zero products (the UI gate can be bypassed by an old tab); the "you're live" banner on the dashboard;
dashboard Settings still shows `localhost:4000/s/` in dev instead of `storeAddress()`; service-worker cache
bump for the changed JS/CSS; the Leaflet map modal was not re-checked on 320-360px phones this batch; ToS /
Privacy links still `#`. Nothing here was run against real Postgres or a real device.

## WIP 16 (batch 6) — PARTIAL: product-form return flow + server-side launch guard only

Date: 2026-09-24

**Task:** Continue from batch 5's own question — "finish the product-form return flow and the
server guard first, banner and Settings link after." Only the first two were done this round;
stopped there to package and hand back rather than run further unverified changes.

**Done:**
- **`js/product-form.js` now honours `?from=onboarding`.** The constructor reads it into
  `this.fromOnboarding` and sets `this.returnTo` to `'onboarding.html?step=4'` instead of the
  hardcoded `'dashboard.html#products'` — the one line that actually closes the loop batch 5 left
  open (the "Add your first product" button already linked here; saving just dropped the seller on
  the dashboard afterward instead of back on the review step). Everywhere else that navigates away
  (`saveProduct`'s success redirect, `handleDelete`'s redirect, and the unsaved-changes confirm
  handler on the back button) already read `this.returnTo` dynamically, so none of those needed to
  change. Also relabels the breadcrumb ("Store setup / Add Product" instead of "Dashboard /
  Products / Add Product" — there's no Products list to go back to until the store is live), the
  back button's text ("Back to store setup"), and the heading/subheading ("Add your first product…
  You'll return to Review & Launch after saving") when arriving this way, so the page doesn't read
  like a generic dashboard detour.
- **Server-side launch guard.** `nextastore-backend/src/routes/store.js`'s `PUT /` now counts the
  seller's active products (`storeId`, `deletedAt: null` — same shape `GET /products` already
  counts with) and throws a 400 before the update if `isPublished: true` is being set on a store
  that isn't published yet and has zero products. This was already anticipated: `onboarding.js`'s
  `launch()` had a comment saying "the server refuses it for a store with no products" and already
  re-runs `loadProductCount()` in its `catch` block — so a rejected launch now correctly re-shows
  the "Add your first product" gate with no further frontend change needed. Closes the gap batch 5
  flagged: the UI gate alone couldn't stop an old tab left open on step 4, or a direct API call,
  from publishing an empty store.
- `nextastore-backend/scripts/qa-static.js` — 5 new checks: the `from`/`returnTo` logic itself, the
  breadcrumb/back-button relabel, that all three redirects still read the dynamic `this.returnTo`
  (not a reintroduced hardcoded link), the guard's exact shape, and that the guard runs *before*
  `prisma.store.update` rather than after (so an already-live store is never wrongly re-checked).

**Verified:** `node --check` clean on both changed files. `qa:static` — **166/166** (161 + 5 new).
Not run in a browser this round (no Chromium session this batch) — code-reviewed against the exact
call sites above, not clicked through. Not run against real Postgres, so the guard's actual 400
response was traced by reading the code, not observed from a live request.

**Still open from batch 5, untouched this round:** the "you're live" banner on the dashboard;
Settings' store-link display (`publicStoreUrl()` / `renderStoreUrlPrefix()` in `js/dashboard.js`
still read `store.publicUrl` directly instead of going through `app.storeAddress()` — this is the
actual source of the `localhost:4000/s/…` text the user saw in Settings, now confirmed by reading
the code rather than assumed; note `viewableStoreUrl()`, what the "View store" button itself opens,
was already fine and unaffected); service-worker cache bump for this batch's two changed files;
Leaflet map modal re-check on 320–360px; ToS/Privacy links still `#`.

## WIP 16 (batch 7) — Settings link fix, "you're live" banner, cache bump

Date: 2026-09-24

**Task:** Continue batch 6's own list — the remaining three items from batch 5's launch-path work:
Settings' store-link bug, the dashboard "you're live" banner, and the service-worker cache bump.
ToS/Privacy pages and the small-phone map-modal recheck were left open (no browser session this
round to verify either against real devices).

**Done:**
- **Settings store-link bug, fixed.** `js/dashboard.js`'s `publicStoreUrl()` (Copy link, share modal,
  SERP preview) and `renderStoreUrlPrefix()` (the "nextastores.com/s/" prefix in Store Basics) both
  used to read `store.publicUrl` directly and parse its host out by hand. In local dev that's the
  backend's own address, which is exactly the `localhost:4000/s/amina-crafts` text reported in
  Settings — and it wasn't styled because it's real backend SSR output, not this app's page. Both
  now call the shared `app.storeAddress()` helper (`js/main.js`) that onboarding already uses, which
  already knows to treat a local/LAN/tunnel `publicUrl` as dev plumbing and fall back to the branded
  `nextastores.com` host instead — the same helper's own doc comment already said Settings was
  supposed to use it. `viewableStoreUrl()` — what the **View store** button itself opens — was
  already correct (an in-app `store-detail.html` link, never the raw SSR page) and needed no change;
  it was the displayed/copied address text that was wrong, not the button's destination.
- **"You're live" banner.** New dismissible banner at the top of Overview (`#storeLiveBanner` in
  `dashboard.html`, `.welcome-banner--live` in `css/dashboard.css`, `renderLiveBanner()` in
  `dashboard.js`), following the same pattern as the existing draft-notice/setup-nudge banners.
  Shows the branded store link and a "Share your store" button (opens the existing share modal —
  `showShareModal()`, unchanged) only right after Launch, keyed off the same
  `nextastore_just_launched` sessionStorage flag onboarding's `launch()` already sets. Replaces the
  old one-shot `app.showAlert` toast, which could come and go during the onboarding→dashboard
  redirect before the seller was even looking at the screen — the actual complaint behind "more
  visible 'you're live' moment" in `OPEN_ITEMS.md`. Dismissing sets an in-memory flag (not
  sessionStorage) so it stays dismissed for the rest of this session without needing a second flag;
  a refresh clears `justLaunched` entirely either way, same as the toast did before. `store.isPublished`
  is checked too, purely as a safety net, so a launch that actually failed the new server-side guard
  (batch 6) can never show "you're live" for a store that isn't.
- **Service-worker cache bump.** `CACHE_VERSION` v13 → v14, covering this batch's and batch 6's
  changed files (`dashboard.js`, `dashboard.html`, `dashboard.css`, `product-form.js`).
- `nextastore-backend/scripts/qa-static.js` — 7 new checks: both link-helper fixes (and that the old
  hand-rolled localhost-prone regex is actually gone, not just shadowed), that `viewableStoreUrl` was
  deliberately left alone, the banner's markup, `renderLiveBanner()`'s exact guard logic, that the old
  toast string is gone, that `loadStoreBranding()` actually wires the new render call in, and the
  cache-version bump.

**Verified:** `node --check` clean on all seven touched JS files. `qa:static` — **173/173** (166 + 7
new). Also ran `push-sw-test.js` (the in-VM suite that doesn't need a browser) since the cache version
changed — **57/57**, and it already derives its expected cache name from `CACHE_VERSION` dynamically
rather than a hardcoded number, so future bumps won't need it touched again. No duplicate HTML ids
introduced (checked with a full re-grep of `dashboard.html`). Not run in a real browser this round —
the banner's show/hide/dismiss logic and the Settings link text are code-reviewed against the exact
call sites, not clicked through, and none of this has run against real Postgres.

**Still open:** real Terms of Service / Privacy Policy pages (signup links are still `#`); the Leaflet
map modal has not been re-checked on 320–360px phones since batch 5; nothing in batches 5–7 has been
seen in a real browser or on a real device.

## WIP 16 (batch 8) — Terms/Privacy pages, map modal checked and fixed on small phones

Date: 2026-09-24

**Task:** Continue batch 7's two remaining items: the real Terms of Service / Privacy Policy pages
(signup links were `#`) and the Leaflet map modal re-check on 320-360px phones.

**Map modal — checked in real Chromium this round** (Playwright, touch emulation, 320x568, 360x640, 375x667,
390x844, 412x915, 640x360 landscape, 768x1024, 1440x900). Real Leaflet cannot be downloaded in this sandbox
(no network), so the test used a small layout-only stand-in for `L` (`map`, `marker`, `panInside`, zoom control).
That verifies the modal's own layout, floating cards and buttons; it does NOT verify real tile rendering,
real drag/pinch behaviour or Leaflet's own `panInside`. Findings and fixes:
- **Pin hidden under the summary card.** Tapping the bottom ~65px of the map put the pin behind the floating
  "selected location" card (confirmed at every width). New `keepPinInView()` calls Leaflet's `panInside` after a
  drop and after a drag so the pin always ends up in the clear area.
- **Guidance banner covered the zoom buttons** at every phone width — banner's right edge now leaves a gutter.
- **Selects were truncated at 320px** ("Central Regi...", "Kampala (Cit..."). Region options are now just "Central /
  Eastern / Northern / Western" (the label already says Region), only cities carry a "(City)" suffix (the
  "(District)" suffix on every option is gone), and District/City gets the wider column.
- **Close / dismiss / remove-pin icons were Font Awesome glyphs.** With the CDN blocked (as in this sandbox, and
  plausible on a weak connection) the close button was invisible. Now inline SVG.
- **Landscape phones (360px tall):** chrome took 57% of the height and the tip banner covered most of the map. New
  `max-height: 480px` rules: labels visually hidden (selects keep their labels for screen readers), tighter header,
  filters and buttons, coordinates line dropped from the card. Map area 154 -> 201px.
- Tip copy shortened so it no longer leaves a one-word last line at 320px.
- Result across all 8 viewports: modal exactly fills the screen on phones, no horizontal scroll, Cancel/Save fully
  in view and >= 40px tall (46px portrait), pin never hidden, no page errors.

**Terms of Service + Privacy Policy.** New `terms.html`, `privacy.html`, `css/legal.css` (sticky table of contents on
desktop, collapsing to a card on phones, "short version" summary box). Written from what the product actually does
(no payment processing/escrow, orders are requests, phone shown only if the seller chooses, Seller Pass, hashed
passwords, push notifications naming the account, OpenStreetMap use in the picker, Ugandan governing law and the
Data Protection and Privacy Act, 2019). Signup's links now open them in a new tab (the agree box is still required
and still enforced in `handleSignup`). Terms/Privacy links added to every footer that had the Trust & Safety link and
to the marketplace footer; both pages added to the sitemap; canonical host is nextastores.com. Checked in Chromium at
360 and 1440px: no overflow, no page errors. Service-worker cache v14 -> v15.

**Verified:** `node --check` clean; `qa:static` 183/183 (173 + 10 new); `push-sw-test` 57/57.

**Needs a human before launch:** (1) a Ugandan lawyer should review both pages — they are a careful plain-language
draft, not legal advice, and an HTML comment at the top of each says so; (2) they point support/data requests at
nextawillstechnologies.com and in-app messaging because no support email is on file — add a real one in each page's
Contact section; (3) the Seller Pass wording is deliberately generic ("shown on the Subscription page"), and the
"features may be limited when coverage ends" line should be checked against what expiry actually does.

## WIP 16 (batch 9) — End-to-end check of the whole launch path (no app code changed)

Date: 2026-09-24

**Task:** "Continue". Nothing from the original login/signup/onboarding ask was left unbuilt after batch 8, but
batches 6-7 (return flow, server launch guard, banner, Settings link) had only ever been code-reviewed. This round
clicked the whole path through in real Chromium (Playwright, 390px touch viewport, API on :4000 stubbed in the
test, so no real backend/Postgres) and found no app bugs.

**Verified (18 checks, all pass):** index "Get Started Free" -> `signup.html?type=seller` with the Sell card
pre-selected and the seller heading; signup with the terms box unticked sends no request and shows "You need to
agree to continue"; the Terms link opens `terms.html` in a new tab and leaves signup untouched; ticking it creates a
seller account and lands on onboarding; `?step=4` with no products shows "Add your first product" and the branded
`nextastores.com/s/<slug>` link (no localhost); the button opens `product-form.html?from=onboarding` with the
"Store setup" breadcrumb, back link and heading; saving a product (photo, name, category, price) returns to
onboarding with "Launch store" now the primary action; Launch publishes and opens the dashboard with the "You're
live" banner (branded link, Share button, Dismiss); Settings' link prefix reads `nextastores.com/s/`; no uncaught
page errors. Separately, a stale tab launching after the last product was removed is refused by the (stubbed)
server guard and onboarding stays put and re-shows the "Add your first product" gate.
Also grepped for non-Ugandan example names (John/Jane/Sarah/etc. in placeholders, seed data, JS): none.
Note: onboarding strips `?step=4` from the URL after reading it (`history.replaceState`) — intended, not a bug.

**Added:** `nextastore-backend/scripts/browser-flows-py/` — these scripts plus the map-modal layout test from
batch 8, with a README on how to run them.

**Not verified (unchanged):** the server-side guard's real 400 against a real database (the stub re-implements
the same rule), real Leaflet tiles/drag, Safari/Firefox, real devices, and the Postgres migrations.

## WIP 19 - one store page, clean store links, empty payments by default
Date: 2026-09-24

- **No more second store page.** The `/s/<slug>` crawler page is gone. `/<slug>` now serves
  the real `store-detail.html` with per-store head tags (`src/seo.js renderStoreShell`,
  `src/routes/seo.js`, `src/storeShell.js`). `/s/<slug>` 301s to `/<slug>`. Drafts get generic
  tags + noindex; unknown slugs get the same page with a 404 status.
- **Clean URL.** `nextastores.com/<slug>` everywhere (`app.storeLink()`, `app.storeLinkFor()`,
  `app.storeAddress()`, sitemap, `publicUrl`, terms.html). `store-detail.js` reads the slug from
  the path and rewrites old `?store=` URLs. Login `?redirect=` now accepts a bare slug.
- **Reserved slugs** (`src/slugs.js`): generated slugs get `-store`; typed ones are rejected.
- **Payments start empty.** Column default changed (migration `20260924120000_store_payments_start_empty`,
  hand-written, not run), starter store sends `payments: {}`, onboarding saves every method as an
  explicit true/false, skipped steps no longer show a tick. Seed + integration test now enable
  MTN/Airtel explicitly.
- **Slug field:** prefix text now matches the input's size/weight (onboarding + Settings).
- Service-worker cache v15 -> v16.

### Still open from this batch
- Auth pages: left panel not sticking (`html,body{overflow-x:hidden}` breaks `position:sticky`;
  fix = `overflow-x:clip` on `body[data-auth-page]`) and big-screen (1920px+) layout. Not done.
- Onboarding desktop layout pass. Not done.
- `/<slug>` route smoke-tested with stubbed Prisma on real Express (live/draft/unknown/case/
  slash/id/legacy/reserved all as designed) but never against Postgres or a browser. Production
  needs the "static file first, else API" proxy rule (README, "Store links").
- Migration not applied yet (`npx prisma migrate deploy`).

## WIP 20 - auth pages: fixed sticky brand panel, improved wide-desktop layout
Date: 2026-09-24

- **Root cause of the non-sticky login/signup panel**: `html,body{overflow-x:hidden}`
  (global, `css/main.css` + `css/mobile.css`, loaded on every page). Setting
  `overflow-x` to anything but `visible` forces the browser to auto-compute
  `overflow-y` too, which turns `body` into its own scroll container. Every
  `position:sticky` element then sticks to *that* box instead of the viewport,
  and since body's box is exactly as tall as its content, the sticky element
  never visibly moves - it just sits at its normal position. This wasn't
  auth-only: every `position:sticky` element sitewide (dashboard sidebar,
  checkout summary, admin nav, marketplace/store topbars, legal ToC, ...) had
  the same latent bug.
  - **Fix**: `overflow-x:hidden` -> `overflow-x:clip` in `css/main.css` (incl.
    the 414px media query) and `css/mobile.css`. `clip` blocks the same
    horizontal overflow without creating a scroll container, so it looks
    identical but doesn't break sticky. Verified with a minimal repro (sticky
    panel visible after scroll with `clip`, gone with `hidden`) and
    programmatically on the real pages: `.auth-side`'s distance from the
    viewport top stays 0 at both scroll-top and scroll-bottom, on login and
    signup, at two different viewport heights.
- **Wide-desktop layout** (`css/auth.css`, `@media (min-width:1600px)`): below
  1600px the panel/form split already balanced (checked at 1536px). Above it,
  the form column grew with the window while the card stayed a fixed width,
  so the extra space became a bare gutter on each side of the form. Now the
  form column is capped (`minmax(480px, 40rem)`) and the freed width goes to
  the brand panel instead; the card, back link and headline scale up slightly
  so the composition still feels intentional at 1920px/2560px rather than a
  fixed island in a bigger frame. Checked at 1920px and 2560px.
- Both existing test suites still pass (183/183 static, 16/16 SEO) - neither
  touches these two pages, so this is a visual/manual check, not a new
  automated one.

### Still open
- Onboarding desktop layout pass - not started this batch.
- Everything listed as open in WIP 19 that isn't finished above (migration not
  applied, production proxy rule not deployed, `/<slug>` route never tested
  against Postgres or a real browser).

## WIP 21 - onboarding: wide-desktop layout pass
Date: 2026-09-24

- **Wide desktop (>=1600px)** (`css/onboarding.css`): the centered content column
  was capped at 1200px with no upper adjustment, so past ~1600px viewport width
  the page just grew emptier margins on both sides as the window widened - the
  same "fixed island" pattern the auth pages had. Measured before fixing:
  container margins were 168px/360px/680px per side at 1536/1920/2560px (all
  symmetric - it was centered, just not using the extra width). Now, past
  1600px the column widens to 1360px and the live-preview rail grows from
  380px to 420px, so the extra room goes into the form and the (more visual)
  preview rather than just the gutter. Checked at 1920px and 2560px on step 1;
  steps 2-4 share the same container/rail so they scale with it.
- **Review step grid** (`css/onboarding.css`, `.onboarding-review-grid`):
  spotted while doing the above pass, not desktop-specific - a fixed 2-column
  grid held exactly 3 real fields (location, phone, payment methods), so the
  third always sat alone with a visibly empty cell next to it, at every width
  from 601px up. Now 3 columns at >=769px (fills evenly, checked at 1200px);
  unchanged (2-column) from 601-768px and single-column under 601px, both as
  before.
- Service-worker cache v16 -> v17 (onboarding.css changed).
- Both suites still pass (183/183 static, 16/16 SEO) - visual-only change,
  checked by hand at 390px/700px/1200px/1920px/2560px, not by a new automated
  check.

### Still open
- The 601-768px range still has the review-grid gap (2-column, one item
  alone) - left as is since that's tablet width, not the "desktop" that was
  asked about; flagging in case it's wanted too.
- Everything listed as open in WIP 20 (migration not applied, production
  proxy rule not deployed, `/<slug>` route untested against Postgres/a real
  browser).

## WIP 22 (batch 12) — fixed the Step 1 flash on the way back to Step 4
Date: 2026-09-25

**Bug:** finishing "Add your first product" from onboarding (`product-form.html?from=onboarding`)
already redirected to the correct place, `onboarding.html?step=4` — but that landing page visibly
flashed Step 1 before jumping to Step 4. Root cause: `onboarding.html`'s static markup hardcodes
Step 1's panel as `active`, and `OnboardingWizard.init()` (`js/onboarding.js`) only decides the real
starting step — including honoring `?step=4` — *after* its data fetches (`loadExistingStore`,
`loadPaymentMethods`, `loadProductCount`) resolve. The app's generic page skeleton dismisses within
two animation frames, unrelated to those fetches, so the hardcoded Step 1 panel painted for the
whole duration of the network calls before snapping to Step 4.

**Fix:**
- `onboarding.html` — wrapped the step area (`#obMain`) in an `ob-main--loading` state with a small
  spinner (`.ob-main-loading`), present by default in the markup.
- `css/onboarding.css` — while `.ob-main--loading` is present, the progress bar / card / action
  buttons are `display: none` (not just visually covered) and the spinner shows instead.
- `js/onboarding.js` — `init()` now removes `ob-main--loading` immediately before its one
  `renderStep()` call, once `this.step` holds its final, validated value (the existing
  `?step=` + `basicsComplete()` guard against a hand-edited URL is unchanged). Both the loading
  class removal and the panel-class toggling happen synchronously in the same tick, so the browser
  never gets a paint in between — no flash, whichever step is actually landed on.
- Service-worker cache `v17` → `v18`.

**Verified:** `node --check` clean on `js/onboarding.js`. `qa:static` — **187/187** (183 + 4 new:
that the loading wrapper/spinner markup exists, that the CSS actually hides the panels rather than
overlaying them, that the reveal happens after `?step=` is resolved and before the single
`renderStep()` call, and the cache-version bump). `push-sw-test` — 57/57. Not run in a real browser
this round.

**Still open:** everything listed as open in WIP 21, plus the same "needs a live environment" items
in `OPEN_ITEMS.md`.

## WIP 23 (batch 13) — fixed the step-1 slug-nudge overlap on mobile
Date: 2026-09-25

**Bug:** on Step 1, once you edit the store name after already customizing the store link, the
"still want this link?" nudge (`.ob-slug-nudge`, `id="obSlugNudge"`) shows its warning text and its
two action buttons ("Use /<new-slug>" / "Keep my link") overlapping each other on phones — screenshot
was iPhone 16 width (393px), but it's not a single-breakpoint bug. Root cause: `.ob-slug-nudge` laid
out its three children (icon, message `<p>`, `.ob-slug-nudge-actions`) as a plain `display:flex` row
with no wrap. A row flex with no explicit flex-basis lets the browser shrink the `<p>` down toward
its min-content width to make room for whatever else is in the row, instead of ever dropping the
actions to their own line — so the paragraph got squeezed into a narrow column and the two buttons
sat stacked beside it, overlapping the tail of the warning text. Widescreen mostly hid this because
there was enough room for both without squeezing; mobile made it visible.

**Fix (`css/onboarding.css`, `.ob-slug-nudge`):** switched the container from row-flex to a 2-column
grid (`auto minmax(0,1fr)`). Icon sits in column 1 / row 1; the message `<p>` sits in column 2 / row
1 and can now wrap at its full available width instead of being squeezed; `.ob-slug-nudge-actions`
is pinned to column 2 / row 2, so the button row always renders on its own line under the message,
indented to match the text (not the icon), at every viewport width — not just below some breakpoint.
No HTML changes needed.
- Service-worker cache `v18` → `v19`.

**Verified:** `qa:static` — still 187/187 (no existing check asserted on the old flex layout, so
nothing needed updating). Not re-checked in a live browser this round — worth a quick look at the
393px case from the screenshot plus a wider width once this build is running somewhere real.

**Still open:** everything listed as open in WIP 22, plus the same "needs a live environment" items
in `OPEN_ITEMS.md`.

## WIP 24 (batch 14) — two logic bugs from a full read-through of the onboarding flow
Date: 2026-09-25

Asked to find and fix any bugs in the onboarding flow generally (not just CSS this time), so read
`js/onboarding.js`, `onboarding.html` and the map-picker/map-preview/image-crop APIs it calls in
full end to end, and cross-checked every `PUT /store` field name against
`nextastore-backend/src/validation.js`'s `updateStoreSchema` (all match — no silently-dropped-field
bug there). Two real ones found:

1. **`checkSlugNudge()` hardcoded `nextastores.com`.** The "you changed your name, still want that
   link?" message on step 1 built its text with the literal string `nextastores.com/${currentSlug}`,
   instead of going through `app.storeAddress()` like everywhere else that shows the store's address
   (`obSlugPrefix`, the review step, Settings). `storeAddress()`'s own doc comment in `js/main.js`
   says the host is deliberately read from the backend's `publicUrl`/`SITE_URL` "so when the platform
   moves to nextastore.ug this follows it with no frontend change" — this one spot didn't follow that
   and would have kept naming the old domain. No visible symptom today (current `SITE_URL` *is*
   nextastores.com), but it's a live landmine for the domain migration mentioned in prior sessions,
   or for anyone testing against a differently-configured `SITE_URL`. Fixed by computing
   `app.storeAddress(currentSlug, this.store.publicUrl).display` and using that in the message.

2. **`basicsComplete()` didn't enforce the slug's 3-character minimum.** The step-1 "Next" button
   validation requires `this.store.slug.length >= 3` ("Your store link needs at least 3 letters or
   numbers."), but `basicsComplete()` — which drives both the step-1 progress dot's "completed" state
   and the `?step=4` deep-link guard in `init()` — only checked the slug was non-empty. A 1-2
   character slug could therefore read as "step 1 complete" even though it could never actually pass
   Next and get saved. Added the same `>= 3` check so both places agree.

- Service-worker cache `v19` → `v20` (`js/onboarding.js` changed).

**Verified:** `node --check js/onboarding.js` clean. `qa:static` — still 187/187 (neither bug had
existing coverage, and nothing already-passing needed updating). Cross-checked `NextaStoreMapPicker`'s
and `NextaStoreMapPreview`'s exported APIs (`open`, `close`, `label`, `kind`, `districtCoordinates`,
`render`) against every call site in `onboarding.js` — all match, no dead calls. Not re-checked in a
live browser this round.

**Still open:** everything listed as open in WIP 23, plus the same "needs a live environment" items
in `OPEN_ITEMS.md` — in particular, the map picker step is still only ever code-reviewed, never
clicked through against real Leaflet tiles over a network (see OPEN_ITEMS.md, WIP 16 batches 5-9).
