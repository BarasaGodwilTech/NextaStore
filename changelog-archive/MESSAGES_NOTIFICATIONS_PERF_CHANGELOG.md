# Messaging performance + notification item dots

## Deploy order
Either order is safe. Prefetch calls the NEW route `GET /messages/conversations/:id/peek`;
a backend that doesn't have it yet answers 404 and the prefetch silently does nothing
(the click then loads normally). It is a separate path, not a `?peek=1` flag, precisely
so an old server can't ignore the flag and mark threads read on hover.
Redeploy the backend (Railway) for prefetch to actually work. Service worker cache: v10 -> v11.

## Messaging (js/messages.js, js/thread-cache.js, routes/messages.js)
- **Opening a thread paints first.** The tap opens the pane, pushes history, clears the row's
  unread badge and draws the thread from an in-memory cache — or, if it isn't cached, the header
  (from the list row) plus skeleton bubbles, with the composer already usable. THEN a normal GET
  runs (this is what marks the thread read) and is reconciled with no flicker; the reader's
  scroll place and any "Load older" history are kept. The badge refresh no longer gates anything.
  Deep links (notification taps) load the list and the thread in parallel.
- **ThreadCache** (js/thread-cache.js): in-memory only, LRU 30, 15 min max age, tied to the
  signed-in user id, dedupes in-flight prefetches; never written to storage.
- **Prefetch on intent**: mouse dwell 80 ms, touchstart 40 ms (cancelled if it becomes a scroll),
  keyboard focus, and bell items that point at a thread. Uses `.../peek` (no mark-read, no
  session renewal). Skipped on Data Saver / 2G / offline / hidden tab / fresh entry / >2 in flight.
  A tap that lands while a prefetch is on the wire paints the moment it arrives.
- **Optimistic sending**: pending -> sent (swapped in place from the POST reply — no thread or
  list refetch) / failed (Resend, Delete, persisted). Composer never disables (that closed the
  phone keyboard). Sends queue per conversation so order is kept. 20 s timeout turns a hung
  request into a failed bubble (the clientId makes Resend safe). List row preview + ordering
  update instantly. Only the first message of a brand-new conversation holds the Send button.
- Bugs fixed on the way: a Resend of a failed FIRST message reappeared as failed; scroll position
  leaked between threads (`_scrolledOnce`); a deep link to a conversation older than the first list
  page drew the wrong header (a seller saw their own store name) and lacked seller attach options;
  a snapshot could make an in-flight bubble vanish; our own message delivered by poll before its
  POST reply showed twice; "No conversations yet" could flash before the first list response.

## Notifications (js/main.js, css/main.css)
Two notions of unread, deliberately separate (this was already true on the server; now explicit
on the client):
- bell exterior count = `acknowledgedAt` (opening the bell clears it) — unchanged;
- each item = `readAt` (only tapping/opening that item, or Mark all as read, clears it).
New:
- **Green dot** on every unread item (gold stays the bell count's colour), plus the tint and a
  screen-reader-only "Unread:" prefix. Dot presence == `is-unread` == `data-notification-unread`.
- **NotificationStore**: keeps the list in memory (re-opening the bell draws instantly, then
  revalidates only if something changed) and an overlay of locally-read items, so a list response
  that was already in flight can't resurrect a dot you just cleared; a failed mark-read stays
  cleared on screen and is retried on the next load; Mark all is optimistic and rolls back if the
  server refuses.
- Opening a thread settles that thread's item in the panel (`settleByLink`) and re-checks the
  bell count ~1.2 s later (the server settles just after serving the thread).
- Open panels refresh on the 20 s badge tick. The panel shows all returned items (up to 30, it
  scrolls) instead of the first 10, so an unread item can't be hidden where its dot is never seen.
- `SessionData.onSessionEnded` now drops the notification store and the thread cache.

## Unread filter in the bell panel
- The panel has an **All | Unread (n)** switch under the header. Every open starts on All, so a
  leftover filter can never make a new notification look missing.
- Backend: `GET /notifications?unread=1` returns the newest 30 UNREAD (routes/notifications.js), so
  unread items older than the newest 30 are reachable — with >30 notifications that is the whole
  point. An older backend ignores the parameter and returns everything; the client then filters
  locally (tested), so backend and frontend can deploy in either order.
- The Unread view is every unread item known from either list, so it draws instantly (even with a
  slow server) and never flashes "all caught up" while unread items exist; the server's unread list
  then adds the ones past the newest 30. Tapping an item there clears its dot but leaves the row until
  the filter is re-entered (the list doesn't jump under the tap) and the count drops at once. Mark all
  as read empties the view ("You're all caught up") and restores it if the server refuses. With more
  than 30 unread it says "Showing your newest 30 of N unread."
- The number on "Unread" is the server's total (it can exceed the 30 listed) minus reads the total
  doesn't reflect yet — a read confirmed before that request was issued is not subtracted twice.
- Looked at on desktop and at a 390px phone viewport.

## Tests
New: `npm run test:messages-perf-browser` (23), `npm run test:messages-flows-browser` (39),
`npm run test:notifications-dots-browser` (28), `npm run test:notifications-filter-browser` (26),
10 new static checks. Key checks were confirmed to FAIL against deliberately broken code
(read-overlay off; failed copy removed under the wrong key; scroll not cancelling touch prefetch).
messages-flows covers: touch / keyboard-focus prefetch, touch cancelled by scroll, Data Saver, a tap
landing while a prefetch is in flight; "Message seller" (first message creates the conversation,
compose screen becomes the thread, second Enter held, then normal sends); a failed first message
(persisted across reload, Resend reuses the clientId, no ghost afterwards); location and product
attachments (pending card -> one sent card; failing with content intact; Resend once); "Load older"
+ cache (150 messages from cache in <400ms, still 150 in order after revalidation).
Run against the final code: qa-static 141/141, notifications 21/21, presence-messages 11/11,
presence 17/17, mobile-drawer 79/79, push-sw 48/48, push-sw-browser 20/20, push-page 32/32,
push-prompt 30/30.

Limits of these tests: they run in headless desktop Chromium against a FAKE of the API, not on a
real phone or the real server. Touch is simulated with touchstart/touchmove events, not a real
touchscreen gesture; slow networks are simulated with delays.
NOT run: `integration-test.js` (needs Postgres). Neither backend route change has been exercised
against a database: `/conversations/:id/peek` (the existing handler with the mark-read write skipped)
and `/notifications?unread=1` (one added `where` clause). After deploying, hit each once:
`GET /api/messages/conversations/<id>/peek` should return the thread and leave its unread count
unchanged; `GET /api/notifications?unread=1` should return only items with readAt null.
