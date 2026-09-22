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

## Not actually built yet

- **Push notification redesign (Prompt 5, half done)** — `service-worker.js` still uses one
  `PUSH_ICON` / `PUSH_BADGE` constant for every notification type; nothing differentiates icon
  or badge by type. The *title* formatting for messages is already sender-name-first ("New
  message from X", built in `notifyNewMessage`), which covers part of the ask, but the
  icon/badge differentiation itself was never built.
- **Seller-side payment settings still hardcoded** — `js/store-builder.js`'s payment-method
  checkboxes and `dashboard.js`'s payment-badge summary (~line 387–390) both still hardcode
  MTN/Airtel/card by array position instead of rendering from `/payments/methods`, so an admin
  adding/removing a payment method from the catalog won't show up in either place without a
  frontend redeploy. *(AUDIT_CHANGELOG.md — flagged there as "not started")*
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
