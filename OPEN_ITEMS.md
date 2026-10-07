# Open items

One place for everything that's genuinely still unresolved or unverified across the
project, pulled out of `changelog-archive/` and `WIP_LOG.md` so it doesn't stay scattered
across 20+ files. Two different kinds of "open" are mixed together in the source files —
separated here:

- **Needs a live environment** — the code is written and reviewed, it just hasn't been run
  against a real Postgres database, a real browser other than Chromium, or a real
  device/deployment, because none of those were available in the sandbox this work was
  done in. Nothing to build — just verify.
- **Not actually built yet** — an ask that was never implemented, not just unverified.

## Needs a live environment (verify, don't rebuild)

- **Product address + WhatsApp preview (WIP 42 + 43)** — a product's own address
  (`nextastores.com/<store-slug>/<name>-<key>`, which is also what the browser shows) is built and
  tested (real handlers, stubbed DB/cache; real Chromium with the real page renderer; crawler view
  over raw HTTP) but nobody has pasted a real link into WhatsApp from a deployed site yet. To check:
  deploy, open a product and copy the link **from the address bar**, send it to yourself on WhatsApp;
  the card should show the product photo, "Name – UGX price" and the store line. Then tap Share >
  WhatsApp on the product page (same address). Facebook's Sharing Debugger shows exactly what a
  crawler read. WhatsApp caches a link's preview, so use a never-shared product (or add `?x=2`) when
  re-testing. Also confirm: an old `/product-detail?id=...` bookmark still opens the product and
  tidies its address; Back from a shared link reads "Back to store"; the PWA (installed app) still
  opens product pages (the service worker cache moved to v33). **Deploy note:** the new address only
  works where your proxy sends non-file paths to the API (the documented `try_files $uri $uri.html $uri/
  @api` rule; `http-server -P` locally) - the same rule store links already need.
  *(WIP_LOG.md, WIP 42 and 43)*
- **Two message/notification routes** (`GET /messages/conversations/:id/peek`,
  `GET /notifications?unread=1`) — matched their changelog on code review; never run against
  a live database. *(MESSAGES_NOTIFICATIONS_PERF_CHANGELOG.md)*
- **Auth/session round 8** — real-Chromium suite passes 54/54, but: never run against real
  Postgres/Prisma (so `tokenVersion` revocation is a no-op until `migrate deploy` runs), never
  tested in a browser other than Chromium 141 (Safari/iOS PWA storage/bfcache behavior in
  particular is untested), and the "Log out of all devices" *button* itself was never clicked
  (only the calls its handler makes). *(AUTH_AUDIT_CHANGELOG_ROUND8.md)*
- **Subscription reminder notification** (WIP 09) — the whole path (dashboard/subscription
  page load → bell row + push when a trial is inside 3 days) is code-reviewed and unit-tested,
  not run end-to-end against a seeded store. *(WIP_LOG.md, WIP 09)*
- **Installed-PWA reload on update** (WIP 09b) — the `controllerchange` reload logic is a known
  pattern for this API, but hasn't been watched happen on a real installed PWA resumed from the
  background. *(WIP_LOG.md, WIP 09b)*
- **Presence, end to end** — round 11's frontend work was written against the *documented*
  shape of `routes/presence.js`'s responses, never against a running backend; no browser test
  exists for `messages.js`/`store-detail.js`'s own presence wiring (only `presence.js` itself
  was browser-tested); the "show my activity status" opt-out was suggested, never built.
  *(PRESENCE_FRONTEND_CHANGELOG_PART2_INPROGRESS.md — see also the note below.)*
- **Dynamic payment methods, checkout side** — `GET /api/payments/methods`, admin CRUD, and
  checkout's own fetch of the catalog were never run against a live database.
  *(AUDIT_CHANGELOG.md)*
- **WIP 11's three pieces (completed-orders removal, seller order-action simplification,
  buyer cancellation)** — code-reviewed and `qa:static`-clean (145/145), but nothing in this
  round ever ran against a real Postgres database (the new `buyer_order_cancellation`
  migration included) or a real browser: the seller's Confirm/Mark completed/Cancel buttons
  and the buyer's cancel-reason modal were never clicked through. *(WIP_LOG.md, WIP 11)*
- **WIP 12's push badge differentiation** — the fast in-VM suite (`push-sw-test.js`, no
  browser needed) passes 52/52 against the real service worker. Its real-Chromium twin
  (`push-sw-browser-test.js`) was updated with matching checks but not run — same Playwright
  caveat as everything else on this list — and no real Android device has seen the six new
  badges actually render in its status bar. *(WIP_LOG.md, WIP 12)*
- **WIP 13's dynamic payment methods in onboarding** — `js/store-builder.js` (named in the old
  audit) turned out not to exist anymore; the actual hardcoding was in `onboarding.js`/
  `onboarding.html`, now wired to `/payments/methods`. `dashboard.js`'s payment rendering was
  already dynamic and needed no change. Code-reviewed and `qa:static`-clean (151/151), but
  never clicked through: an admin adding/removing a method in `/admin` and reloading
  onboarding to confirm step 3 and the review-step chips pick it up is unverified against a
  live database and a real browser. *(WIP_LOG.md, WIP 13)*
- **WIP 26's two-photo payment-proof scanner** — the deferred "Extract details" flow (queue up to
  2 photos, OCR them together, merge the amount/reference across whichever photos actually read)
  is code-reviewed and `qa:static`-clean (200/200), but the sandbox it was built in has no network
  access to Tesseract.js's CDN and no browser, so the OCR itself has never actually run. Needs a
  real click-through: attach 2 photos with the amount and ID on different screens and confirm both
  merge into one result, and attach a blank/blurry photo and confirm the "nothing readable" note
  appears. *(WIP_LOG.md, WIP 26)*

## Not actually built yet
- **Booking orders and digital delivery (future, WIP 47)** — services and digital items are enquiry-only for now (built in
  WIP 47, not yet run against Postgres or a browser; needs `prisma migrate deploy`). The booking-order plan is in
  `nextastore-backend/README.md` ("Listing types"). *(WIP_LOG.md, WIP 44-47)*
- **Notifications dropdown caps at 10** — the server returns 30, but the dropdown only shows
  the newest 10; nothing beyond that is visible except via "Mark all as read". No full
  notifications *page* exists, though the original spec allowed for one.
  *(NOTIFICATIONS_TWO_TIER_FRONTEND_CHANGELOG.md)*
- **Admin users table** — still a horizontally-scrollable `min-width:850px` table rather than
  the responsive card layout the other dashboard tables got; allowed by spec, just inconsistent
  with the rest of the drawer/table cleanup. *(MOBILE_DRAWER_AND_TABLES_CHANGELOG.md)*
- **Presence "part 2c"** — `NOTIFICATIONS_TWO_TIER_FRONTEND_CHANGELOG.md`'s own title refers to
  building "on top of presence part 2c" as an already-finished prerequisite, but no changelog
  for a "part 2c" exists anywhere in this project bundle. `js/presence.js` is loaded across the
  live pages, so presence does appear to be wired in — I just can't find the file that would
  confirm part 2's own open items (above) were actually closed out. Worth a quick check if
  presence matters to you right now.
- **Responsive fixes, prompts 9–11 as originally scoped** — the original ask was: audit every
  page at 360/390/430/768/desktop, produce a written findings report ranked by severity, then
  fix highest-severity issues first, page by page. What actually happened
  (`RESPONSIVE_AUDIT_COMPLETED.md`) was a source-level audit that found most pages *already*
  had adequate breakpoint rules, plus four targeted fixes (product-form header wrapping,
  messages standalone-PWA viewport, dashboard search dropdown width, subscription copy
  clarity). That may well be the right amount of work — but if you were expecting a page-by-page
  severity-ranked report and a broader fix pass across all ~20 pages, that didn't happen.
- **Dashboard UX pass (Prompt 12)** — never started. No self-audit of dashboard friction points
  and no fixes beyond WIP 09's three specific bug reports (banner contrast, cache bump, trial
  reminder), which were reactive fixes from a screenshot, not the proactive "find and fix 5-10
  friction points" pass that was asked for.

## Not a bug, just worth knowing
- **Idle sign-out at 30 minutes counts input only** — someone reading in a background tab for
  40+ minutes will find themselves signed out on return; that's the intended behavior, not a
  defect. `IDLE_LIMIT_MS` in `startIdleTimer` (`js/main.js`) is the one constant to change if
  you want it longer. *(AUTH_AUDIT_CHANGELOG_ROUND8.md)*

## From WIP 16 batch 4 (added 2026-09-24)
- **Needs a live environment** — migration `20260924090000_store_live_notification` never run against
  Postgres; the "Account: <name>" push line never seen on a real device; auth pages never seen with
  icons loaded or in Safari/Firefox.
- Everything else this batch flagged as "not built yet" was picked up in batches 5–6 below — see
  those instead of this line.

## From WIP 16 batches 5–9 (updated 2026-09-24)
- **Not built yet:** nothing from the original login/signup/onboarding ask. Real Terms of Service / Privacy Policy pages
  now exist (batch 8) — they still need legal review and a real support email (see `WIP_LOG.md`, batch 8).
- **Needs a live environment:** batches 5-7's onboarding, launch-guard, Settings-link and "you're live" work was clicked
  through end to end in real Chromium in batch 9, but against a stubbed API — never against real Postgres or the real
  backend routes. Batch 8 checked the map modal's layout in real Chromium at 320-1440px, but with a layout-only stand-in for
  Leaflet (no network in the sandbox): real tiles, real pin dragging/pinch-zoom, Leaflet's own `panInside`, iOS Safari
  and a real device are still unverified.

## From WIP 29-30 (storefront polish, added 2026-09-29)
- **Needs a live environment:** the storefront (`priceRange`, slider, filter drawer, heart -> favorites API) and WIP 30's
  presence owner-preview fix and card overflow fixes were only exercised against mock data in Chromium — never against
  the real backend/Postgres, never with real product photos, never in Safari/iOS (range-slider thumb styling in
  particular). *(WIP_LOG.md, WIP 29 and 30)*
- **Unconfirmed:** the `/api/presence/store/amina-crafts` console 404 is explained by the owner-preview gap fixed in
  WIP 30 *only if* you were previewing your own draft/lapsed store; otherwise suspect an older running backend. The
  `NextaLoader timed out ... waiting for: page` warning was not reproduced; WIP 30 only stops follow-state from being
  able to cause it.
- **Built in WIP 31, needs a live environment:** `GET /favorites/check?ids=` (storefront hearts in one request, with a
  per-card fallback on older backends) — unit-tested with stubs only, never against real Express/Postgres.
- **Not built yet:** live presence *stream* updates for an owner previewing a draft store.

## From WIP 33 (password hashing, added 2026-09-29)
- **Needs a live environment:** the worker-thread password pool (`src/password.js`) was only exercised with a stubbed
  database in the sandbox — never against real Postgres, never on your actual host. Check that login, signup, reset and
  password change work on the deployed backend, and that a login while other requests are running no longer stalls them.
  If your host forbids worker threads it silently falls back to blocking in-thread hashing. *(WIP_LOG.md, WIP 33)*
- **Decided (WIP 34):** no public "payment overdue" note on a closed store; a badge gives only a small edge over unbadged
  stores (no ranking between tiers); real placement is reserved for a future paid-promotion feature, **not built yet**.
- **Worth watching:** the badge edge is a hard step (all badged stores list above all unbadged ones on the marketplace
  list). If unbadged stores get buried once many sellers have badges, soften it — see WIP_LOG.md, WIP 34.


## From WIP 36 (product page, added 2026-09-29)
- **Needs a live environment:** the photo viewer's pinch-zoom, swipe, swipe-down-to-close, Back-button close and scroll lock were only driven by synthetic pointer events in desktop Chromium — never with real fingers, on a real phone, or in iOS Safari. Also never seen with real product photos or icons loaded (Font Awesome is a CDN the sandbox can't reach). *(WIP_LOG.md, WIP 36)*
- **Decision for the owner:** the old product-page shipping fees and 7-day return policy were invented and have been removed; the tab now says delivery/returns are agreed with the seller. If you want real numbers shown, they need to be per-seller fields (fee, timing, return window) that sellers set — **not built yet.**
- **Not built yet:** sticky "Add to Cart" bar on phones; merging the duplicated Description tab into the top description.

## From WIP 37 (clean URLs, added 2026-09-30)
- **Before deploying:** apply the nginx clean-URL block from `nextastore-backend/README.md` ("Clean URLs") on the production proxy, or enable the host's clean-URLs option. Without it `/dashboard` etc. will 404. *(WIP_LOG.md, WIP 37)*
- **Check locally once:** `start-local.bat` now uses `http-server -e html`; confirm `http://localhost:3000/dashboard` opens (not verified against the real http-server here).
- **Overview store-info section:** done in WIP 38 (see below).
- **Pre-existing browser-test failures (also in WIP 36):** `messages-flows` (uncaught `reading '0'` page error, 38/39) and `mobile-drawer` (orders page status control not found at 390px, 78/79). Worth a look; not caused by WIP 37.

## From WIP 38 (Overview store-info header, added 2026-09-30)
- **Needs a live environment:** checked in real Chromium against a fake API only. Never seen with a real logo/banner image, with Font Awesome icons loaded (CDN unreachable in the sandbox), in Safari/iOS, or on a real phone. *(WIP_LOG.md, WIP 38)*
- **Known limit:** a revenue figure over ~1 trillion UGX wraps mid-number in the mini-stats cell. Everyday amounts do not. If ever needed, compact large numbers (e.g. "UGX 1.2T") with the full figure in a tooltip.
- **Not changed, still open:** the Dashboard UX pass (Prompt 12) and the admin users table remain as listed above.

## From WIP 39 (Overview store info, added 2026-09-30)
- **Not yet tested with long content:** the Settings > Store form, the public store page (`store-detail`) and the store cards on `stores`/`marketplace`. Only the dashboard Overview block was covered.
- **Needs a live environment:** as WIP 38. Pin/Edit icons and the address toggle were seen without Font Awesome. *(WIP_LOG.md, WIP 39)*
- **Watermark on existing product photos (WIP 49)** — only newly added photos are stamped. Stamping the old ones needs an
  image library on the server (none installed) or each seller re-adding photos. Also decide: a seller on/off switch?

## From WIP 50 (marketplace rebuild)
- **Check the claim "Payments handled for you"** in the Seller CTA on `marketplace.html` (and "No setup fees"): left as written. Fulfilment is
  directly between buyer and seller, so make sure the wording is true.
- **Footer social links** (facebook.com/nextastore, twitter.com/nextastore, instagram.com/nextastore) were already there and are unchanged;
  confirm those accounts exist.
- **Product cards have no favourite heart** on the marketplace (store pages and favorites.html do). Not added: needs the favorites state wiring.
- **Needs a real look:** open `/marketplace` on a phone with real data, and with a logged-in seller account (hero button, header).

## From WIP 53 (Nexi, added 2026-10-03)
- **Needs a live environment:** run Ollama + `ai-assistant` + backend together and ask the six starters in English; check answer quality, first-token time and total time on the real
  machine (CPU-only can take 20-60 s; consider a smaller model or a GPU). Run `npm run reindex` (four new knowledge files).
- **Add to your real `nextastore-backend/.env.example`** (it was not in the zip I received): `ASSISTANT_URL=http://127.0.0.1:4100` and optionally `ASSISTANT_TIMEOUT_MS=120000`.
- **Luganda:** get a Sunbird API key, then `npm run translate:starters`. Check Sunbird's price / limits / terms and add the third-party disclosure to the privacy policy.
  Until then the Luganda starters are drafts and Luganda questions get English answers plus a note. Have one Luganda speaker spot-check money / safety answers once.
- **Production:** keep port 4100 private; if the backend runs on a different machine set `ASSISTANT_URL` to its private address. The proxy limits are per IP (needs the existing `trust proxy` setting to be right).
- **Knowledge accuracy:** `ai-assistant/src/knowledge/02-selling-and-stores.md` and `04-...seller-pass.md` were written before WIP 27/28 (badge ladder, Seller Pass plans); re-read them against
  the live platform so Nexi doesn't state old facts. New files 08-11 deliberately avoid fees and badge rules.
- **Design follow-ups (optional):** the hero chat could remember a "sell vs buy" choice; a typing/answer-time estimate; admin view of which questions Nexi couldn't answer.


## From WIP 54 (Luganda on the server + VPS, added 2026-10-03)
- **Needs a live environment:** run `npm run bench` on your own machine before paying for the VPS, then `deploy/setup-vps.sh` on the real server. Check `free -h` / `ollama ps` with all three models loaded
  (plan: about 6 to 6.5 GB used of 8) and that swap stays quiet. If an English answer takes more than about 20 s, use a smaller chat model or a bigger plan.
- **Luganda quality:** have one Luganda speaker read real answers from Ganda Gemma (especially money, fees, safety) and put approved wording in `ai-assistant/src/lang/translation-memory.json`.
  Its published score is modest (BLEU about 7, chrF++ about 40 on English -> Luganda), so treat it as a helper, not a final authority. The phrasebook entries are still unreviewed drafts.
- **Not built:** reading Luganda *questions* into English locally (needs NLLB, a Python service and more RAM). Sunbird does it if you accept sending those chats to them.
- **Privacy policy:** with `LOG_LUGANDA_MISSES=true`, Luganda question text (first 300 characters, no account or IP) is stored on the server; mention it. Local Luganda sends nothing to third parties.
- **Backend `.env`:** add `ASSISTANT_TOKEN` (same as the assistant's) and `ASSISTANT_TIMEOUT_MS=150000`. The backend `.env.example` was not in the zip, so it was not edited.
