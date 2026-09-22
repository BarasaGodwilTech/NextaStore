# Mobile drawer + responsive tables (spec item 4): verification pass

`css/mobile.css` already had a 100dvh / scrollable-nav / pinned-footer fix for
the dashboard drawer, and Logout WAS reachable at every phone size I tried.
This pass added the first real-browser test of it and fixed what it turned up.

## New: `scripts/mobile-drawer-browser-test.js` (`npm run test:mobile-drawer-browser`)
Real `dashboard.html`, signed in as a seller, fake API on localhost:4000.
79 checks at 390x844, 360x560, 667x375 (landscape), 320x480, plus a mid-open
resize to desktop, a 1280px desktop view, the account menu on
`marketplace.html` at 360x400 and 390x844, and the orders table at 390px.
Covers: closed drawer out of the tab order; 44x44 targets (hamburger, every
nav item, Logout); drawer pinned to the top edge; Logout fully on screen and
what a tap there actually hits, even with the nav scrolled to its end; no
layout shift beneath the drawer; scroll lock; Tab trap; Escape / overlay tap /
choosing a section all closing it with the toggle kept in sync; resize reset.
Headless Chromium cannot emulate a real iOS home-indicator inset or the
address bar resizing the viewport, so those stay a manual check on a device.

## Fixed
1. **Orders table was unusable on a phone (the real find).** `.table-responsive`
   is `overflow:hidden`, so the 7-column orders table was clipped at 390px: a
   seller could not reach an order's Status select or View button. Under
   768px the dashboard tables (orders, top products) are now labelled card
   stacks (`data-label` on each cell, printed by `::before`); desktop keeps the
   real table. Status select and View are 44px tall on phones.
2. **Drawer sat 4px low.** A fixed element with no `top` keeps its static
   position, which was under the 4px store accent bar, so the bottom 4px of
   the drawer was off screen. `top:0` added.
3. **No modal behaviour:** the page behind the drawer scrolled; a closed
   drawer was still tabbable off-screen; the section-choose path closed it
   without telling the hamburger; no Escape; no focus handling; resizing to a
   wide screen mid-open left the overlay up. One controller (`setDrawerOpen`)
   now handles all of it, with `aria-expanded`/`aria-controls` and a
   "Open menu"/"Close menu" label. Respects `prefers-reduced-motion`.
4. **Account menu on every other page:** on a 400px-tall screen Log out sat
   below the fold of the scrolling panel. It is now sticky at the panel's
   bottom edge.

## Not done / worth knowing
- Admin (`admin.html`) has no drawer: it is a top bar plus a scrolling tab
  strip (tabs are 44px tall). Its users table is `min-width:850px` inside an
  `overflow:auto` wrapper, i.e. horizontally scrollable, which the spec allows.
  It was not converted to cards and was not run under this test.
- Admin/RBAC (spec item 6) is not touched here. There is role and permission
  code already; it has not been reviewed or tested in this pass.
- Only the dashboard tables were converted. Any other `<table>` added later
  needs `data-label` on its cells to get the card layout.
- `main.css` / `dashboard.css` / `mobile.css` / `dashboard.js` changed after
  the v8 service worker bump: fine while v8 is unreleased, otherwise bump v9.
- Icons (Font Awesome CDN) do not load in the offline sandbox, so the
  screenshots I checked had blank icon slots; layout and hit boxes are what
  was tested.
