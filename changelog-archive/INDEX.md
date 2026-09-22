# Changelog archive — index

These are completed / historical changelogs, moved out of the project root so it stays
readable. Nothing was deleted — every file here is unchanged content, just relocated
(one exception: `AUTH_AUDIT_CHANGELOG_ROUND8_INPROGRESS.md` was renamed to
`AUTH_AUDIT_CHANGELOG_ROUND8.md` — see its entry below for why).

Ongoing work lives in `../WIP_LOG.md`. Anything genuinely still open or unverified,
pulled out of the files below, is tracked in one place: `../OPEN_ITEMS.md`.

Grouped by feature thread, oldest → newest within each:

## Launch design pass
- **AUDIT_CHANGELOG.md** — the original brand/design-token pass (colors, typography, error
  pages), plus a later, separate, partially-finished "dynamic payment methods" effort mixed
  into the same file. See `OPEN_ITEMS.md` for what's still open there.
- **PRODUCTION_RELEASE_AUDIT.md** — a point-in-time production-readiness snapshot, 2026-09-13.
  Historical; superseded by everything after it.

## Auth / sessions
- **AUTH_AUDIT_CHANGELOG_ROUND8.md** *(renamed from `..._ROUND8_INPROGRESS.md`)* — despite the
  old filename, its own "Not done yet" section says every finding from the original audit is
  addressed, and step 4's real-Chromium suite passes 54/54. What's actually still open is
  narrower than "in progress" suggested: no run against real Postgres/Prisma, and no browser
  other than Chromium tested. Renamed for accuracy; content untouched.

## Messages
Six rounds of the same feature thread — each is a real checkpoint, not a duplicate. Round 4's
"still open" list (notifications merging raw messages, mobile/desktop behavior, load speed) was
fully closed out across rounds 6–7; round 7 itself flags a round-6 "still to do" list that
undersold what was already done.
- **MESSAGES_AUDIT_CHANGELOG.md** — round 1: mobile back-button fix and other early findings.
- **MESSAGES_AUDIT_CHANGELOG_ROUND2.md** — security + scale audit.
- **MESSAGES_AUDIT_CHANGELOG_ROUND3.md** — location/product card redesign, send-preview.
- **MESSAGES_AUDIT_CHANGELOG_ROUND4_INPROGRESS.md** — failed sends + a stale-data race. Its own
  "still open" list is resolved by rounds 6–7 (see above) — kept as-is (not renamed) since it's a
  point-in-time snapshot, accurate for what round 4 itself shipped.
- **MESSAGES_AUDIT_CHANGELOG_ROUND7.md** — send queue, mobile-vs-desktop behavior, poll fixes;
  the biggest single round. Contains round 6's own checkpoint content too (re-audited and
  corrected at the top of the file).
- **MESSAGES_AUDIT_CHANGELOG_ROUND8.md** — mobile/PWA viewport lock-in fix + pull-to-refresh.
  This is the round that covers the "PWA standalone scrolling" bug.
- **MESSAGES_NOTIFICATIONS_PERF_CHANGELOG.md** — in-memory thread cache, prefetch-on-intent,
  optimistic sending, per-item unread dots. Verified end-to-end in WIP 01–03 (see `WIP_LOG.md`)
  except two routes never exercised against a live database — tracked in `OPEN_ITEMS.md`.

## Notifications
- **NEW_PRODUCT_FOLLOWER_NOTIFICATION_CHANGELOG.md** — followers get a bell + push when a
  followed store adds a product.
- **NOTIFICATIONS_TWO_TIER_FRONTEND_CHANGELOG.md** — frontend verification pass for the
  read/acknowledged two-tier bell, built on presence part 2c (see Presence below).

## Presence
- **PRESENCE_GROUNDWORK_CHANGELOG.md** — round 11 step 2: database column only, nothing reads it
  yet.
- **PRESENCE_BACKEND_CHANGELOG.md** — round 11 step 3: server side built and tested; browser side
  still not wired at this point.
- **PRESENCE_FRONTEND_CHANGELOG_PART2_INPROGRESS.md** — round 11 step 4: frontend wiring,
  explicitly not run as a suite. `NOTIFICATIONS_TWO_TIER_FRONTEND_CHANGELOG.md` refers to a
  later "presence part 2c" as already done, but no changelog for a "part 2c" exists in this
  project bundle — `js/presence.js` is loaded across the live pages, so presence does appear to
  be wired in, but I couldn't find the file that verifies part 2's own open items were closed.
  Flagged in `OPEN_ITEMS.md`.

## Push notifications
- **PUSH_NOTIFICATIONS_CHANGELOG_PART1.md** — package 1: server + service worker.
- **PUSH_NOTIFICATIONS_CHANGELOG_PART2A.md** — package 2A: page-side subscribe/unsubscribe.
- **PUSH_NOTIFICATIONS_CHANGELOG_PART2B.md** — package 2B: soft prompt, iOS guidance, consent
  copy, credential re-registration.
- Per-notification-type icon/badge differentiation and non-message title/body formatting were
  never part of any of these three packages — that's a real gap, tracked in `OPEN_ITEMS.md`.

## Admin
- **ADMIN_RBAC_CHANGELOG.md** — admin redesign + role-based access, spec item 6.

## Mobile / responsive
- **MOBILE_DRAWER_AND_TABLES_CHANGELOG.md** — dashboard drawer verification pass; one table was
  flagged as not converted/tested — see `OPEN_ITEMS.md`.
- **RESPONSIVE_AUDIT_COMPLETED.md** — WIP 07's source-level responsive audit (findings only, not
  a full fix pass across every page — see `OPEN_ITEMS.md`).

## Emoji → Font Awesome
- **EMOJI_AUDIT.md** — the full inventory + final per-row replacement status. Superseded by
  `WIP_LOG.md`'s WIP 06a–06f entries, which narrate the actual replacement work; kept here since
  it's the audit's source of truth (glyph list, file/line, proposed mapping).

## Subscription / Seller Pass
- **PRODUCTION_SUBSCRIPTION_UI_UPDATE.md** — 2026-09-15 redesign: payment journey, tier/badge
  policy, mobile layout, server-side amount validation. Predates the "make the tier comparison
  scannable" ask, but `subscription.html` already has a three-card tier layout (`.badge-tier`)
  and a sidebar link from `dashboard.html` — both hold up on inspection.
