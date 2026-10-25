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

## Nexi launch checklist (final, WIP 101: Nexi is frozen)

This ONE list replaces the Nexi launch items that were spread over the WIP 53, 54, 87, 93, 97 and 100 sections. There is no more Nexi feature work: what is left is owner-only checking, deciding and deploying. How to run everything is in `ai-assistant/README.md`, "Operating Nexi".

**Done (covered by tests; re-run them, do not redo them)**
- [x] Luganda never shows English (handoff instead); hallucination guard; the assertion-support guard (a yes / no / figure needs one supporting sentence); distress and safety questions are answered, never a menu; clarify chips never repeat a task.
- [x] Handoff to WhatsApp (real anchors, keyboard reachable, summary built from the current chat); the person link sits under the composer in both views.
- [x] Retrieval, calibration and the answer-change check; weekly traffic review with abusive / injection / private rows counted and never listed.
- [x] Design system: one token block, one-row header, cards and handoff button as thread children, 160 ms entrance (off under reduced motion), jump-to-latest, 44 px targets, AA contrast at 320 / 390 / 1280 in English and Luganda (`design-audit` 61/0 including the starter-chip clipping check, `ui-audit` 39/0).
- [x] Suites as listed in the README table; service-worker cache v70 with `sw-assets.hash`.

**Owner-only**
- [ ] **Real dependencies.** `cd ai-assistant && npm ci`, then every suite in the README table. The sandbox had no network: `selftest` and `wip93-test` ran against small stand-ins for `express`, `cors` and `dotenv`, so expect the same numbers but confirm them once.
- [ ] **Live model.** Ollama with `CHAT_MODEL` set, assistant running, `npm run eval:chat`; ask the six starters in English; record first-token and total times (CPU-only can take 20-60 s: a smaller model or a GPU if slow). Optionally compare `qwen2.5:1.5b-instruct` with `qwen2.5:3b-instruct`. Then stop Ollama and ask `how do I pay for my seller pass`, `how do I get a seller badge`, `how do I open a store`, `how long is the free trial`, `how do I track my order`, `how do I sign up`: each fallback answer must carry the right real numbers and link, in complete sentences, with no file name or "knowledge base" wording.
- [ ] **Real phones** (Android Chrome and iOS Safari): open the hero chat and the floating panel with WhatsApp contact ON and OFF; the title, EN / LG toggle, "Need a person? Chat on WhatsApp" and the cards must all be visible and not overflow; watch an answer stream (no half `[Open` link or `**` flashing); scroll up and use "Jump to latest"; keyboard open: the panel takes focus and Escape returns it.
- [ ] **Backend and deployment.** In `nextastore-backend/.env`: `ASSISTANT_URL`, `ASSISTANT_TOKEN` (same as the assistant's), `ASSISTANT_TIMEOUT_MS` (about 150000 for a CPU server), `SUPPORT_EMAIL`, `SUPPORT_URL`, `SMTP_HOST`, `SMTP_FROM`. Keep port 4100 private. `npx prisma migrate deploy` against the real database. Deploy with service-worker cache `v70`.
- [ ] **VPS** (if using the 8 GB plan): `npm run bench`, then `deploy/setup-vps.sh`; check `free -h` and `ollama ps` with the models loaded (about 6 to 6.5 GB of 8) and that swap stays quiet.
- [ ] **Luganda.** A Luganda speaker reviews `lg-review/NEXI_LUGANDA_REVIEW.csv` (money, fees and safety first; includes the WIP 101 strings `need_person`, `handoff_hint`, `jump_latest`) and the question cues in `assertionGuard.js`, marks rows `approved`, then `npm run lg:review:import -- <file>`. Free-form Luganda needs `GANDA_MODEL`. Re-enable the three disabled phrasebook entries (`cancel_order`, `seller_badge`, `starter_buy_safely`) only after rewrite and review.
- [ ] **Policy and legal.** Add the Seller Pass non-refundable rule to `terms.html` and `subscription.html` (Nexi already states it from the live facts). Approve the three English sentences added in WIP 93 (password-to-support FAQ, the "Support hours:" suffix, the neutral Seller Pass payment wording). Privacy policy: mention the scrubbed question log (`LOG_FLAGGED_MESSAGES`, `LOG_LUGANDA_MISSES`) and, if used, outside-world web queries (`WEB_SEARCH_URL`).
- [ ] **Facts and web search.** Change one backend fact in a test environment and confirm Nexi's answer follows within one sync interval (no guide edit). Web search stays OFF unless `WEB_SEARCH_URL` points to a private SearXNG-compatible endpoint; if you turn it on, also set `WEB_ALLOWED_DOMAINS`, `WEB_TIMEOUT_MS`, `WEB_CACHE_MINUTES`, `WEB_MAX_CHARS`.
- [ ] **Weekly from launch:** `npm run review:traffic -- --days 7` and paste useful alias lines (README).

**Decisions for the owner (not launch blockers)**
- `oos-15` is 14/15 (93%) on the strict ruler because "do you sell iphones" shows an honest catalog reply instead of a handoff; `scripts/oos-eval.js` also reports a third ruler that counts it. Leave it (correct when the catalog is up) or route "do you sell <product>" to a one-line marketplace answer.
- Clarify and catalog-cards turns can still answer a fact question without the guides (1 of 25 in `oos-25b`, 6 of 30 in `oos-25c`); the reply-level guard cannot reach them.
- Folding the review-side insult / injection patterns of `traffic-review.js` into the live classifier ("you are a useless stupid bot" is not flagged live today).
- `blind-4` false handoff is 5% (2 of 40) and the `wip97` p95 overhead margin is thin (about 22-25 ms against 25 ms).
- Parked ideas: hero remembers a sell / buy choice, an answer-time estimate, an admin page for unanswered questions, reading Luganda questions locally.

## Found in WIP 95, FIXED in WIP 96

- **Panel did not take focus when the composer's `visibility` transition was still running.** `open()` called
  `textarea.focus()` once from a 60 ms timer; if that fired while `.nexi-panel-bottom` still computed `visibility:hidden`
  the call was a silent no-op and focus stayed on the floating button (5 of 24 Chromium runs on the WIP 95 tree).
  Fixed: the first attempt is unchanged, then `focus()` is retried per frame (max 30) only while focus is still on `<body>` or
  the floating button.
- **A focused starter arrow that hid itself dropped focus to `<body>`.** Fixed in `update()` of `wireStarterRow`: the focused
  element is noted BEFORE the `hidden` flags change (the browser blurs it synchronously), then focus goes to the other arrow if
  it is showing, otherwise to the first enabled starter chip. Covered by the "arrows 320" section of assistant-ui-browser-test.

## Service-worker cache discipline (WIP 96)

`sw-assets.hash` (project root) records a content hash of every `js/**/*.js` and `css/**/*.css` file plus the CACHE_VERSION
that shipped with it. qa-static fails if those files change without BOTH a CACHE_VERSION bump and a regenerated record.
Workflow after touching any JS/CSS: bump `CACHE_VERSION` in `service-worker.js`, then `npm run sw-assets-hash`
(in nextastore-backend). The tool refuses to regenerate while the assets changed and the version did not.
Known limit: it cannot tell a hand-written record (with matching hashes) from a regenerated one; it catches the honest
mistakes (forgot to bump, forgot to regenerate, hand-edited the combined hash).

## NextaStore Circle and Crew (WIP 103): to do before turning it on

- [ ] `npm run migrate:deploy` (new tables and the `growth` notification type; hand-written, never run on real Postgres), then `npm run test:growth`.
- [ ] Check no existing store already uses a newly reserved slug (`circle`, `crew`, `scouts`, `invite`, `i`, `admin-growth`, `auth-bridge`).
- [ ] Create a private R2 bucket (public access off) and set `R2_PRIVATE_BUCKET_NAME`. Until then Crew applications answer "uploads are not set up".
- [ ] Give the right admins `growth.view` / `growth.review` / `growth.payouts` / `growth.settings` (keep review and payouts on different people).
- [ ] Both programs start closed. In the admin (Circle & Crew > settings) open Circle first, run one real signup > store > first payment > approval > earning > withdrawal, then open Crew.
- [ ] Path mode serves `/circle`, `/crew`, `/invite` from static files if your proxy's `try_files` finds them first. The pages work either way, but link previews only get their placeholders filled when the request reaches Node. Route those paths (and `/i/*`) to the API if previews matter.
- [ ] Optional: subdomains (`GROWTH_MODE=subdomain`, DNS and proxy for `circle.` and `crew.` pointing at the Node app, `/api` answered on both).
- [ ] Optional: send the payer's phone number with subscription payments (guide step 8) so Crew can match a store by phone.
- [ ] Nexi knowledge for Circle/Crew was not added (Nexi is frozen). If wanted, copy the guide's knowledge entries in a separate WIP.
- [ ] Real devices: Crew install-to-home-screen, camera/QR, geolocation check-in, offline lead logging.

## Nexi polish (WIP 104): to check on real devices

- [ ] Run `python3 scripts/starter-row-test.py` and `widget-test.py` in `ai-assistant/` on a machine with Playwright Chromium for Python.
- [ ] Look at the hero and the floating panel on a real small phone (320-360px) in English and Luganda, idle and mid-conversation: full words in the language slider, full subtitle, both slider buttons, nothing cut.
- [ ] On a real desktop, check the two-questions-at-a-time starter row and that the previous / next buttons scroll it.
- [ ] Luganda wording is still unreviewed by a speaker (see the lg-review notes); this WIP changed layout only.
