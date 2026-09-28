# Boot loading overlay — brand-corrected, responsive, data-gated

Replaces the plain `.page-init-skeleton` (paper background + 3 grey bars, dismissed
~2 rAF frames after `App.init()` regardless of whether any real data had loaded) with a
branded full-page loader that stays up until each page's actual data is ready, built from
the two provided mockups (`nextastore-loading-everyone.html` / `-seller.html`).

## Bug found
`dismissPageSkeleton()` in js/main.js fired on a fixed ~2-frame delay, not on data
readiness. On dashboard/orders/favorites/following/messages/onboarding/product-form/
subscription, the skeleton could disappear before that page's own manager had fetched
anything, so people briefly saw whatever default/empty state was sitting in the static
HTML underneath. marketplace/store-detail/product-detail/cart/stores/admin had no
full-page guard at all.

## Root cause of the off-brand color in the "everyone" mockup
`nextastore-loading-seller.html` already used real brand tokens (`--secondary`
`#0B3B2B` / `--secondary-dark` `#062A1F` / `--brand-green-light` `#2EDDA2` /
`--accent-gold` `#FFB038` / `--accent-gold-light` `#FFD88A` / `--paper` `#F7FAF8`, i.e.
exactly the `.btn-primary` gradient). `nextastore-loading-everyone.html` had drifted:
`#0A2E22` / `#051911` / `#16B37E` / `#F5A623` / `#FFDD9E` / `#F7F5EF` — close, but not
one of them matches a real token. Corrected to use the same ink/gold as the seller
theme, with the liquid fill on `--store-green`/`--primary` (`#01B075`) → `--primary-dark`
(`#008558`) instead — the marketplace/storefront green, as distinct from the seller
theme's `--brand-green-light` → `--brand-green-dark` (the button gradient). Both mockups
also pulled Poppins from Google Fonts on every load; dropped that — the app self-hosts
Poppins via `@font-face` in main.css already, so the loader now uses the same `var(--nx-...)`
family stack with zero extra network requests, which matters most on the one screen
that's supposed to be instant.

## New files
- **css/loading-overlay.css** — `#nxLoader`, two themes via `[data-nx-theme="general"|"seller"]`.
  Responsive via `clamp()`/`min()` sizing (logo: `clamp(96px, min(34vw,30vh), 156px)`, shrinks
  further under a `max-height:480px` query for landscape phones), safe-area insets on all four
  sides, `prefers-reduced-motion` support, `color-mix()` glow with plain-rgba fallback. Also
  carries the content-guard rule: `html.nx-loading > body > *:not(#nxLoader)` stays
  `visibility:hidden;opacity:0` (crossfades in over .4s once the class is removed) — this, not
  the loader itself, is what stops default/stale content from flashing, and it's enforced by a
  normal render-blocking `<link>` so there's no timing race with the JS.
- **js/loading-overlay.js** — reads `data-nx-theme` / `data-nx-wait` / `data-nx-timeout` /
  `data-nx-phrases` off `#nxLoader`, no per-page inline config needed. Exposes
  `window.NextaLoader.ready(key)`; the overlay lifts once every key a page declared in
  `data-nx-wait` has reported in. Liquid-fill wave math carried over from the mockups.
  Hard `setTimeout` (default 7000ms, `data-nx-timeout` to override) force-reveals the page
  regardless of pending keys — logs a console.warn naming what never reported — and a
  "Taking longer than usual — continue anyway" button appears ~2.5s before that. Neither can
  be turned off per page: a stuck fetch should never be able to trap someone here.

## Wiring
- **js/main.js**: `App.init()`'s existing rAF-delayed dismissal now also calls
  `NextaLoader.ready('app')` in the same callback — same timing as before (a page that
  redirects via `checkAuthState()` never reaches it, so no change there), just also notifies
  the new overlay. Pages with no page-specific manager (login/signup/forgot-password/
  verify-email) only declare `data-nx-wait="app"`, so they still clear as fast as they did
  before.
- **Manager files** — each constructor's `this.init();` became
  `this.init().catch(() => {}).then(() => window.NextaLoader && window.NextaLoader.ready('page'));`
  (already-`async`, already-awaited-internally in every case checked): marketplace.js,
  dashboard.js, store-detail.js, product-detail.js, stores.js, admin.js, subscription.js,
  product-form.js, onboarding.js, messages.js, favorites.js, following.js, orders.js.
  cart-page.js is the one exception — `CartPageManager` renders synchronously from
  localStorage, so `ready('page')` fires right after construction rather than after a promise
  (nothing to await; the payment-methods list is a secondary, non-blocking fetch).
  Errors still resolve `ready('page')` (via `.catch(() => {})`) so a failed request reveals the
  page's own error state instead of hanging behind the loader.

## Pages changed (18)
dashboard.html, orders.html, favorites.html, following.html, messages.html, onboarding.html,
product-form.html, subscription.html, login.html, signup.html, forgot-password.html,
verify-email.html — old `.page-init-skeleton` markup removed, `#nxLoader` added.
marketplace.html, store-detail.html, product-detail.html, cart.html, stores.html, admin.html —
had no full-page guard before; `#nxLoader` added fresh. Each got `class="nx-loading"` on
`<html>`, a `<link rel="stylesheet" href="css/loading-overlay.css">` + inline `<noscript>`
override (so JS-disabled visitors see content immediately instead of a permanently hidden
page) right after the `css/main.css` link, and `<script src="js/loading-overlay.js">`
immediately after the loader markup, ahead of every other script.

Theme split: **seller** (dashboard, onboarding, product-form, subscription, admin) vs.
**general** (everything else, incl. cart/orders/favorites/following/messages, which any role
can land on).

## Deliberately not touched
index.html, privacy.html, terms.html, safety.html — no dynamic data on load; a splash would
only add perceived delay to a marketing/static page. offline.html and the error pages — kept
dependency-free on purpose. store.html — a synchronous `<head>`-script redirect stub with no
`js/main.js` include; its body (and `.page-init-skeleton` CSS in main.css/mobile.css, kept only
for this file) is never actually seen in practice.

## Preview files rebuilt
nextastore-loading-everyone.html / nextastore-loading-seller.html now just render the shared
`#nxLoader` (correct theme each) against `css/loading-overlay.css` + `js/loading-overlay.js` —
same component the app uses, not a parallel copy that can drift out of sync again. Demo-only
`data-nx-wait="demo"` + a `setTimeout` stand in for a real fetch, plus a "Replay animation"
button (`location.reload()`).

## Tests
node --check on every touched .js file (main.js + 14 managers + loading-overlay.js): pass.
Custom Python HTMLParser tag-balance check (handles self-closing SVG via
`handle_startendtag`) on all 18 app pages + both preview files: pass. Scripted audit confirms,
per page: `#nxLoader` present exactly once, `css/loading-overlay.css` linked before
`js/loading-overlay.js`, `js/loading-overlay.js` loads before the page's own manager script,
and — for every page whose `data-nx-wait` includes `page` — that its mapped manager file
actually contains a `ready('page')` call.

## Not done
No real browser/visual QA (no display in this environment) — the SVG wave math is carried
over unchanged from the two working mockups, but the crossfade reveal, safe-area padding on
notched devices, and the short-viewport (`max-height:480px`) layout haven't been eyeballed on
an actual phone. `.page-init-skeleton` CSS left in main.css/mobile.css rather than deleted,
since store.html still references it.
