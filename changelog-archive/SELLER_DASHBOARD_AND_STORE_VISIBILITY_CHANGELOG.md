# Seller dashboard chrome fixes + store-visibility enforcement

## Bug 1: accent bar / banner could show the wrong color indefinitely
`applyStoreBanner()` (the accent bar + full banner paint) lived only inside
`loadOverview()`. `switchSection()` never calls `loadOverview()` for any other
section, so a seller who landed directly on `dashboard.html#settings`,
`#products`, `#orders`, etc. — a bookmark, a notification link — never got
their real banner color painted; the platform-default green stayed for the
rest of the session. Separately, `init()` called `switchSection()` without
awaiting it (`loadSectionData()` runs async, fire-and-forget), so even the
loading overlay's `ready('page')` signal could fire before that section's
real data had rendered.

Fix (js/dashboard.js): extracted the store-fetch-and-paint logic into
`loadStoreChrome()`, called unconditionally at the top of `init()` before the
section branch. `loadStoreBranding()` (the Overview-specific fields: logo,
description, location, payment badges, followers) now calls
`loadStoreChrome()` too, so Overview still gets a fresh repaint after a
Settings save. `switchSection()` now `return`s `loadSectionData()`'s promise
so `init()` can `await` it on first load; nav-click callers are unaffected
since they don't use the return value.

## Bug 2: the trial/subscription banner only existed on the Overview tab
`storeLiveBanner`, `draftNoticeBanner`, `setupNudgeBanner`, and — most
importantly — `subscriptionNudgeBanner` (the "your store is hidden from
shoppers, reactivate" banner) were all nested inside
`<section id="overviewSection">`. Every `.dashboard-section` is
`display:none` except the active one, so a seller who spent their whole
session in Products/Orders/Settings/Analytics never saw the reactivation
banner at all — undermining the entire point of it.

Fix (dashboard.html / dashboard.css / dashboard.js): moved all four banners
into a new `#dashboardStatusBanners` wrapper, sitting between the sticky top
bar and `.dashboard-content` — dashboard-wide chrome, not part of any one
section. `updateStatusBannersVisibility()` collapses the wrapper to zero
height when nothing inside it is visible (called after `loadStoreChrome()`
and from both dismiss-button handlers), so a healthy store doesn't carry an
empty gap under the header.

## Store visibility: closing gaps in "an unpaid/draft store shouldn't be
## reachable by any means"
The backend already had the right idea — `isStoreCurrentlyActive()` (trial
not yet ended OR a confirmed payment covers today) gated the store's own
page, and the dashboard already nudged toward reactivating. But the same
rule wasn't applied everywhere a buyer could actually reach a store or its
products, so a store correctly locked on its own page could still surface
elsewhere:

- `products/deals`, `products/public`, `products/public/:id` — filtered
  `isPublished` but not subscription status, so an expired store's products
  still appeared in the deals feed, the marketplace grid, and via a direct
  product link.
- `store/search` — the stores query filtered `isPublished` only (no
  subscription check); the products query didn't even filter `isPublished`.
- `products` (`GET /`, used by both a storefront's public product grid via
  `?store=slug` *and* a seller's own dashboard product list with no query) —
  had no visibility check at all. A buyer could pull a full product list
  straight from this endpoint even after the store page itself correctly
  404'd.
- `store/follow/:storeId` (POST) and `favorites/:productId` (POST) — neither
  checked the store's status, so new engagement could still be created with
  a draft/expired store by anyone with a raw id.
- `messages` (`POST /`) — starting a brand-new conversation (or a new
  product thread) with an inactive store wasn't blocked.

Fix: added two shared helpers in helpers.js —
`storefrontVisibleWhere()` (a Prisma where-fragment: not deleted, published,
and currently within trial or a paid period) and `assertStoreVisible(store,
req)` (throws a structured 404 unless the requester is the store's owner) —
and applied them everywhere above. Reused in `products.js`'s `GET /` too,
since it's the same rule with the same owner exception, just resolved via
`resolveContextStore()` instead of a direct id. Existing conversations and
existing follows from before a store went inactive are deliberately left
alone (see `store/follow` GET, `messages.js` — only *new* threads are
blocked) so an in-progress order or relationship isn't retroactively
severed; only new discovery and new contact are closed off. This was a
considered choice, not an oversight — see the design note in messages.js.

## Draft vs. expired: distinct messaging instead of one generic 404
`GET /store/public/:idOrSlug` and `GET /store/public` threw the same
"This store is not currently active." for both a store still in draft and
one whose trial had lapsed. Now `assertStoreVisible()` throws
`STORE_DRAFT` or `STORE_INACTIVE` (extended `middleware.js`'s error-code
allowlist regex to pass a `STORE_` prefix through to the client, same as the
existing `TOKEN_`/`ACCOUNT_` ones). `store-detail.js`'s
`renderStoreUnavailable(code)` (replacing the old one-size-fits-all
`renderEmptyStore()`) shows three distinct, appropriately-toned states:
still being set up (encouraging — nothing's wrong, check back soon),
currently unavailable (neutral — never exposes *why* to a shopper), and the
original generic "not found" for anything else (genuinely deleted, or a
network error). Also fixed a sequencing bug: `init()` now returns early when
`loadStoreData()` couldn't load the store, so `loadProducts()`'s own
generic empty-state fallback doesn't immediately overwrite the specific
message that was just rendered.

## Settings sub-nav: wrong mobile breakpoint
The Settings section's own sidebar (Store/Account/Notifications) only
switched to its mobile layout (stacked, horizontal scrollable tabs) at
`max-width: 480px`, while the rest of the dashboard (main sidebar → slide-out
drawer, tables → card stacks) already switches at `768px`. Between 481-768px
— any tablet, plus plenty of phones — the settings sidebar stayed a fixed
250px column, squeezing the actual form into whatever was left of a
`.settings-container` that also carries its own margins. Moved the
structural rules (`.settings-container`, `.settings-sidebar`, `.settings-nav`,
`.settings-main`, `.form-row`) to the existing 768px block; left the purely
cosmetic ones (heading size, toggle-item padding) at 480px.

## Follow-up: settings-container margin still got zeroed on mobile
Verifying the breakpoint move above turned up one more issue: a leftover
rule further down the *same* `max-width: 768px` block — `.settings-container
{ margin: 0; }`, grouped under an unrelated "Dashboard content padding on
mobile" comment — was declared *after* the new `margin: var(--spacing-md)`
line. Same selector, same specificity, so the later declaration silently won
the cascade and the container's margin stayed 0 on every screen ≤768px
regardless of the fix above. The structural stacking (sidebar → full width,
row-nav → horizontal scroll, form-row → single column) all worked as
intended; only this one margin value was quietly overridden. Removed the
stray duplicate so the intended `var(--spacing-md)` margin actually applies.

## Follow-up 2: full Settings UI/UX pass (all sub-tabs, all breakpoints)
Went through every piece of Settings — sidebar/nav, all three sub-tabs
(Store: Basics/Location/Branding/Payments/Search & sharing, Account,
Notifications), the jump chips, the sticky save bar, logo/banner upload,
colour presets/picker, payment-method rows, the SERP preview, and the
shared map-picker modal — against every breakpoint that touches
dashboard.html (1024/768/480px, plus the map modal's own 640/420/380px and
short-screen queries). Structure, touch targets (44px on jump chips, sticky
save buttons, map filter selects, sidebar nav), iOS zoom-prevention on
inputs, and safe-area insets all check out, verified down to a 360px-wide
phone.

Found and removed two pieces of dead code while in there (no functional
change, both confirmed unreferenced anywhere in the codebase before
removal):
- `.settings-tabs`/`.settings-tab`/`.settings-content`/`.settings-panel`
  (an older tabs-based Settings layout) and `.settings-grid` (a later
  attempt) in dashboard.css — both fully superseded by the current
  sidebar layout, just left in the file as dead weight.
- A duplicate `navigateToSettings()` method in dashboard.js. The dashboard
  class had two methods with this exact name; JS silently keeps only the
  later one, so this was never actually broken for users, but the earlier
  (dead) copy queried a `data-settings-tab` attribute that doesn't exist
  anywhere in the markup — a landmine if anyone had edited that copy
  thinking it was live. Removed it, keeping the working one (which
  correctly queries `.settings-nav-item[data-settings-section]`).

Not independently visible from outside the codebase (no visual/browser
rendering available here) — this pass is a thorough static read of the
layout, cascade and breakpoints, not a substitute for opening it on an
actual phone.

## Tests
`node --check` on every touched backend file (helpers.js, middleware.js,
routes/store.js, routes/products.js, routes/favorites.js, routes/messages.js)
and frontend file (dashboard.js, store-detail.js, main.js): pass. Custom
Python HTMLParser tag-balance check on dashboard.html and store-detail.html
(same tool as the loading-overlay changelog): pass. Brace-count sanity check
on dashboard.css: balanced.

## Not done
No visual/browser QA (no display in this environment). Didn't review the
Account/Notifications settings tabs or the Payments subsection of Store
settings in depth — only the sub-nav's own responsive breakpoint. Didn't do
a broader visual/UX polish pass over Products/Orders/Analytics sections
beyond what this file's fixes touch — the dashboard turned out to already
have a lot of deliberate, well-built responsive handling (slide-out sidebar
drawer, table→card-stack conversion, 44px touch targets, reduced-motion
handling), so remaining polish work should be scoped against what's actually
still missing rather than assumed.
