# Messages audit — round 7

## Audit note on round 6
Re-reading js/messages.js before starting round 7 turned up a mismatch with
round 6's own "still to do" list: items 1 (never auto-open a thread) and
most of item 2 (per-message failed state, Resend/Delete, retry reusing the
original send path) were already implemented in the round-6 file — the
history push/replace handling, the request-token guard in openConversation,
and dispatchOptimisticMessage/retryMessage/discardMessage were all present
and, on inspection, correct. Round 6's checklist undersold its own state.
What genuinely was missing is what round 7 below addresses.

# Messages audit — round 6 (checkpoint, IN PROGRESS)

Not the finished release. The js/messages.js rewrite and css/messages.css work
are NOT done. Nothing here has been run in a browser or against a database
(syntax-checked with `node --check` only).

## Done in this checkpoint
Backend (nextastore-backend/src, no migration needed)
- GET /notifications/unread-count: lightweight count for the bell badge.
- New conversation + first message are created in one atomic write; a
  simultaneous double first-send joins the existing conversation (P2002).
- Messages now carry `clientId` (opaque idempotency key) so the sender can
  recognise its own message when a poll delivers it before the POST reply.
- Full thread response now includes buyer, product and store logo, so a
  deep link to an older conversation can draw its header.
- notifyNewMessage skips the bell notification if the recipient already read
  the message (open thread), avoiding a stuck badge.

Frontend
- js/main.js: bell shows real notifications only (message feed and dead
  loadMessagePreview removed). Click marks read and redirects; on the
  messages page it switches thread in place. Links allow-listed (same-site
  .html only). Badge uses the count endpoint, refreshes in parallel and
  pauses while the tab is hidden.
- js/main.js apiRequest: optional `timeoutMs`; errors carry status /
  isNetwork / isTimeout.
- js/messages.js: poll now de-duplicates by id (the 5s server overlap would
  otherwise have shown repeated messages). No other messages.js changes.
- service-worker.js: cache bumped v2 -> v3 so returning users get new JS.

## Done in round 7
Frontend (js/messages.js, css/messages.css, messages.html)
- CSS injection: added `app.cssUrl()` (js/main.js) and applied it to every
  `background-image:url('...')` built from server/user-controlled data in
  messages.js — a value containing a quote or parenthesis could previously
  break out of the CSS string.
- loadOlderMessages: wrapped in try/catch with stale-response guarding; a
  failed request now re-enables the button and shows an error instead of
  leaving it stuck on "Loading…" forever.
- Mobile vs desktop:
  - Removed the base `scroll-behavior: smooth` on `.thread-messages` that
    made opening a thread look like a slow scroll instead of an instant
    jump. The one place that wants an animated scroll (the "jump to
    newest" button) already asks for it explicitly via
    `scrollTo({behavior:'smooth'})`.
  - Enter now inserts a newline instead of sending on touch devices
    (`isTouchDevice()`, `matchMedia('(pointer: coarse)')`); Enter-to-send
    stays a desktop/hardware-keyboard convenience.
  - `focusComposerIfDesktop()` replaces the old unconditional
    `.focus()` calls, so opening a thread no longer pops the on-screen
    keyboard on a phone.
  - A `visualViewport` resize listener keeps the thread's scroll position
    correct (anchored to the bottom, or to the same distance from it) as
    the on-screen keyboard opens/closes.
  - A "New messages" pill (distinct from the plain scroll-to-bottom arrow)
    appears when a poll delivers a genuinely new message while the reader
    is scrolled up, and clears when they scroll back down or tap it.
- Send queue: this was the largest remaining gap.
  - Every optimistic message is now stamped at send time with the
    conversation (or store/product context, for a not-yet-created
    conversation) it was actually addressed to. Retries and background
    completions always target that stamped destination — never whichever
    conversation happens to be open when the request resolves.
  - Failed sends are persisted to `localStorage` (keyed by conversation, or
    by store+product for a first message that failed before the
    conversation existed) and reattached — with working Resend/Delete —
    whenever that conversation/compose screen is reopened, including after
    a full page reload.
  - The frontend now sends the same `clientId` (the message's own temp id)
    on every attempt of a given message, including retries. The backend
    already supported idempotent dedup by `clientId` (round 6) but nothing
    was sending one — a Resend of a message that had actually gone through
    server-side, just with a lost response, could have created a genuine
    duplicate. Fixed by wiring the existing backend support up.
- Poll:
  - A background poll now re-fetches everything already loaded (not just
    the first 20) and reconstructs an equivalent page/limit, so clicking
    "Load more" no longer gets silently collapsed back to page one by the
    next 8s tick.
  - The conversation list only repaints when something in it actually
    changed (a lightweight signature comparison), instead of rebuilding
    the whole list every 8 seconds regardless.

## Audit findings from round 7 (not code changes, just notes)
- The `background-image:url()` escaping gap above also exists in
  js/main.js, js/marketplace.js, js/store-detail.js and js/stores.js
  (the same pattern, `style="background-image:url('${x}')"` with
  unescaped input). Only messages.js was in this round's scope; the same
  `app.cssUrl()` helper (now in main.js) should be applied to those call
  sites in a follow-up pass.
- Everything else audited (history/back-button handling, request-token
  guarding in openConversation, the atomic conversation+first-message
  creation, and the notifications routes) matched what round 6 described
  and showed no issues on read-through.

## Still to do
1. ~~Stop threads opening on their own.~~ Verified already correct.
2. ~~The send queue~~ Done above.
3. ~~Mobile vs desktop behaviour~~ Done above.
4. ~~Poll fixes~~ Done above.
5. ~~Escaping of CSS url() values, and error handling in "load older
   messages".~~ Done above (messages.js only — see audit findings).
6. A browser test at phone and desktop sizes, and a backend test against a
   real database.
   - Browser: done at 390×844 (mobile, touch) and 1440×900 (desktop) with
     Playwright/Chromium — the page loads and runs with no JS exceptions
     at either size. This was a static-file smoke test only (no backend
     available in this environment, confirmed by the expected 403s on API
     calls) — it did not exercise sending, retrying, polling, or any other
     behavior that needs a live server, since none of that can be
     triggered without one.
   - Backend: still needs a run against a real Postgres database in your
     environment — this environment can't install the backend's
     dependencies. `node --check` passes on every file under
     nextastore-backend/src, and the messages/notifications routes read
     correctly on inspection, but neither replaces an actual run.

