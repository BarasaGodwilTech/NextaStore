# Round 11, step 4 — presence FRONTEND, part 2 (checkpoint, NOT run as a suite)

Built on `NextaStore_PWA_checkpoint_round11_step4_presence_frontend_part1`
(which added only `js/presence.js`, wired into nothing).

**Everything below has been written and each touched file passes
`node --check` individually. Nothing has been run as a suite — not
`qa:static`, not `test:presence`, not `test:push`, nothing. Treat every
claim here as "should work by inspection," not "verified."**

## What's in this package, on top of part 1

**Wiring**
- All 15 pages that load the `main.js`/`push.js`/`push-prompt.js`/
  `ui-overlays.js` bundle now load `js/presence.js` right after it:
  `admin.html`, `cart.html`, `dashboard.html`, `favorites.html`,
  `following.html`, `index.html`, `marketplace.html`, `messages.html`,
  `onboarding.html`, `orders.html`, `product-detail.html`,
  `product-form.html`, `store-detail.html`, `stores.html`,
  `subscription.html`.

**`js/messages.js`**
- New `updatePresenceFromConversations(list)`: seeds `window.NextaPresence`
  from each conversation's own `presence` field and calls `setWatch()` with
  the full id list. Called right after `merged` is built in
  `loadConversations()` — **before** the poll fast-path's early return —
  so a background poll that finds nothing else changed still applies fresh
  presence instead of only ever doing so on a full re-render.
- Conversation rows: a `.presence-dot` inside `.conversation-item-thumb`,
  keyed `conversation:<id>`.
- `renderThread()`: a dot on the header avatar, a new
  `.thread-header-status` label line, and a `seed()` call from
  `thread.presence` (covers both the full-load and the deep-link case).
- `pollActiveThread()`: now also seeds presence from the since-poll
  response's own `presence` field, not just its messages/read-receipts.
- `prepareNewConversation()`: dot + label watching `store:<slug>` for a
  conversation that doesn't exist yet, seeded with a one-off
  `GET /presence/store/:slug` call.

**`js/store-detail.js` + `store-detail.html`**
- New `loadSellerPresence()`, called right after `renderStoreInfo()`:
  points the header's dot/label at `store:<slug>`, calls `setWatch()`, and
  seeds from `GET /api/presence/store/:slug`.
- `#storeLogo` is no longer where the dot lives — `renderStoreInfo()`
  clears/replaces that element's contents directly (`innerHTML = ''` /
  `textContent = ...`), which would have wiped a child dot on every
  render. Added a `.store-logo-wrap` sibling wrapper instead; moved the
  banner-overlap `margin-top: -56px` (`-36px` on mobile) from `.store-logo`
  onto the wrapper so the visual position is unchanged.

**CSS**
- `main.css`: shared `.presence-dot` (gray when offline, `var(--success)`
  green when online, invisible until a state is known) and
  `.presence-status` (the text label; `:empty` hides it).
- `.conversation-item-thumb`, `.thread-header-avatar` (messages.css) and
  `.store-logo-wrap` (store-detail.css) all gained `position: relative` so
  their dot can sit absolutely in the corner.

**Service worker + its pinned tests**
- `CACHE_VERSION` bumped `'v7'` → `'v8'`.
- `push-sw-test.js`: the cache-cleanup check used to hardcode
  `'nextastore-cache-v6'`/`'v7'` as "old"/"current" — with the real file now
  on v8, that would have made the real worker's cleanup logic (correctly)
  delete both, while the test still asserted only v6 was deleted. Rewrote
  it to derive both names from the file's actual `CACHE_VERSION`.
- `push-sw-browser-test.js`: same problem, same fix — `CURRENT_CACHE_NAME`/
  `PREVIOUS_CACHE_NAME` are now read from `service-worker.js` at the top of
  the file instead of being written in as literal `v6`/`v7` strings.
- `qa-static.js`'s existing "Service worker cache version is v7 or later"
  check already tolerated this bump; untouched.

**`qa-static.js`**
- New "Presence, frontend half" block, ~14 checks: `window.NextaPresence`'s
  shape, the Authorization/X-Background-Poll headers on the stream request,
  the 401/403/`end:replaced` stop conditions, the script-tag order on all
  15 pages, the conversation-row/thread-header/new-conversation markup and
  seed calls in `messages.js`, the ordering of the presence-update call
  relative to the poll fast-path, `store-detail.js`'s `loadSellerPresence`
  and its placement after `renderStoreInfo`, the `#storeLogo` wrapper, the
  shared CSS rules, the `position: relative` additions, the v8 bump, and
  that the two SW tests no longer hardcode v6/v7.

## Verification pass (added after the above was written)

Run in a sandbox with Node 22 and Playwright/Chromium; no database and no
`npm install` of the backend deps.

| Suite | Result |
|---|---|
| `qa:static` | 116/116 after fixing one check (see below); 117 with the new guard |
| `test:presence` | 36/36 |
| `test:push` (sw, page, prompt, backend) | 48 + 32 + 30 + 27, all pass |
| `test:push-browser` (real Chromium) | 20/20 |
| `test:seo`, `test:new-product-notify` | 10/10, 15/15 |
| `test:presence-browser` (NEW, real Chromium) | 17/17 |
| `test:presence-messages-browser` (NEW, real messages.html vs fake API) | 11/11 |
| `test:integration` | NOT RUN: needs `npm install` + a Postgres |

**Found and fixed**
1. `qa-static.js` "#storeLogo is wrapped…" failed, but the markup was right.
   Its second half (`storeSellerPresenceDot[\s\S]*innerHTML = ''`) matched
   any later `innerHTML = ''` in the file (banner, badges). Rewrote it to
   assert the dot is a sibling after `#storeLogo`'s closing tag.
2. **Real bug in `js/presence.js`:** the 5s auth poll restarted any stopped
   stream while a token still existed, undoing the 401/403/`end:replaced`/
   `end:session-ended` stop. Effect: a request to `/presence/stream` every
   5s per tab after a 401 or session-ended, and with more than 5 tabs
   (`maxStreamsPerUser`) tabs replacing each other in a loop. Now the token
   in effect at a server-side stop is remembered (`hardStopToken`) and the
   poll only restarts for a different token (a fresh sign-in).
   Foreground/`online`/`pageshow` still retry once, as intended.

**New: `scripts/presence-browser-test.js`** (`npm run test:presence-browser`).
Loads the real `presence.js` + `main.css` in Chromium against a fake SSE
stream and checks: dot colour/opacity per state, label text, live flip with
no reload, stale-event and late-REST-seed protection, innerHTML rebuilds,
reconnect on watch change, and the two stop conditions above (verified to
FAIL against the old behaviour).

3. **Real bug, found by the new messages-page test: dots never painted
   after a re-render.** `messages.js` rebuilds the thread header and the
   conversation rows with `innerHTML`, and nothing called
   `NextaPresence.render()` afterwards. With a healthy stream `seed()` is
   (correctly) a no-op and no event was due, so an opened conversation showed
   NO dot and NO label until the next presence event, which could be minutes
   away. That is exactly what the spec's "opening a conversation must
   instantly reflect the participant's status" forbids. `presence.js` now
   watches for added nodes carrying `data-presence-key` (MutationObserver,
   batched to one microtask) and repaints; label text is only assigned when
   it changed, so the observer cannot loop. Fixes every call site at once,
   including `store-detail.js`.

**New: `scripts/presence-messages-browser-test.js`**
(`npm run test:presence-messages-browser`). Opens the REAL `messages.html`
in Chromium, signed in via localStorage, against a fake API on
localhost:4000 that returns the shapes `routes/messages.js` /
`routes/presence.js` document. 11 checks: row dot keyed `conversation:<id>`
and matching the stream's watch key, gray/offline from list data, thread
header dot + "Active 12m ago" on open, live flip to Online in both header
and row with no reload, back to "Active just now", state surviving a
re-render, a `?conversation=` deep link showing Online immediately, and no
uncaught page errors. It failed 4 of 11 before fix 3. It needs port 4000
free (or `PRESENCE_TEST_PORT`).

Totals now: `qa:static` 118/118, `test:presence` 36/36,
`test:presence-browser` 17/17, `test:presence-messages-browser` 11/11, push
suites unchanged and green.

Note on the service worker: `presence.js` changed again after the v8 bump.
That is fine while v8 is unreleased; if v8 already shipped anywhere, bump to
v9 so installed clients pick the new file up.

**Observation, not changed:** a signed-in page opens the stream on load with
an empty watch list, then reopens it when `setWatch` is called. That is one
extra request per page that watches something; harmless, but `messages.js`
and `store-detail.js` could pass the first watch list sooner.

## Not done / not verified — same caveats as before, narrower now

- **Superseded by the verification pass above:** the suites listed there
  have now been run. Still unrun: `test:integration`.
- **No browser test of `messages.js` / `store-detail.js` themselves.** The
  new browser test covers `presence.js` and its CSS, not the page wiring
  against a real backend.
- **Presence data has never round-tripped against a running backend.**
  Everything here was written against what `routes/presence.js` and
  `routes/messages.js` are documented to return (see
  `PRESENCE_BACKEND_CHANGELOG.md`), not against a live server.
- **No "show my activity status" opt-out** — still just suggested, not
  built, per the step 3 changelog.

## Next step

1. Run `qa:static` and `test:presence` (and `test:push`, since two of its
   files were edited) and fix whatever the new checks or the edited tests
   actually turn up.
2. A real Chromium/Playwright pass: two tabs signed in as the two sides of
   a conversation, confirm the dot flips live, confirm the label text
   matches the bucket, confirm a closed tab goes gray after the grace
   period.
3. `npm run migrate:deploy` is still outstanding from step 3 — none of this
   frontend work changes that.
