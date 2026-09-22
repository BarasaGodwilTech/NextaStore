# Web Push — Package 2A: page-side subscribe/unsubscribe core

Package 1 (server + service worker) shipped in `PUSH_NOTIFICATIONS_CHANGELOG_PART1.md`.
This package adds the plain page-side wiring on top of it: turning a browser's
notification permission into a registered device, and back off again. It is
the first of two remaining pieces — package 2B (not started) is the soft
pre-permission prompt with its 3-day/14-day snooze, iPhone "Add to Home
Screen" guidance, per-person consent copy, and re-registering a device after
a password change.

**No phone can receive a push from package 2A alone that it couldn't before**
in the sense that matters for the rollout plan: nothing here nags anyone
automatically. A person has to open the bell or the Settings toggle
themselves. Package 2B's soft prompt is what turns this into an actual
onboarding flow.

## What's in this package

- **`js/push.js` (new file):** the whole page-side API —
  `NextaPush.enable()`, `.disable()`, `.isSubscribed()`, `.getSubscription()`,
  `.serverStatus()`, `.sendTest()`, and `.permission()`. Talks to the four
  routes from package 1 (`/push/public-key`, `/push/status`, `/push/subscribe`,
  `/push/unsubscribe`, `/push/test`) and relays the service worker's
  `ns-push-received` / `pushsubscriptionchange` messages into a bell refresh
  and a silent re-registration.
  - `enable()` never requests the browser's permission dialog except as a
    direct result of calling it — nothing in this package calls it on page
    load.
  - Reuses an existing browser subscription instead of creating a second one
    (some browsers rotate the endpoint on a second `subscribe()` call, which
    would silently orphan the first one server-side).
  - `disable()` always unsubscribes the browser locally even if the server
    call to forget the device fails, and always reports the device as off
    either way — the person's own click is what actually matters, not
    whether the network round-trip succeeded.
- **The bell's "Turn on" row:** the notification dropdown (`js/main.js`) now
  shows a "Turn on push notifications" row above the list, visible only when
  push is genuinely something to offer — supported browser, server has VAPID
  keys configured, this device isn't already subscribed. Clicking it calls
  `enable()` directly; a `ns-push-state-changed` event keeps every bell on the
  page in sync afterward.
- **Settings → Notifications → Push Notifications** (`dashboard.html` /
  `js/dashboard.js`): an on/off toggle backed by real status (not a
  remembered checkbox — it re-checks the browser's actual subscription and
  the server's device count every time the tab is opened) and a "Send a
  test" button wired to `/push/test`. A denied browser permission disables
  the toggle with an explanation rather than letting it show a state the
  device can't act on.
- **`js/push.js` is now loaded on every page that renders the bell** (14
  pages: admin, cart, dashboard, favorites, following, index, marketplace,
  messages, onboarding, orders, product-detail, product-form, store-detail,
  stores, subscription), immediately after `js/main.js`. `safety.html` loads
  no app JS at all today and was left alone — that's a pre-existing gap, not
  something this package introduced.

## Verification

| Suite | Result |
| --- | --- |
| `qa-static` (13 new push checks) | 62/62, was 49/49 |
| `seo-test` | 10/10 |
| Service worker handlers, fake browser (unchanged this round) | 48/48 |
| Backend send, cleanup and `/test` logic (unchanged this round) | 27/27 |
| **New:** page-side `js/push.js`, fake browser (`test:push-page`, now part of `npm run test:push`) | 32/32 |

I broke the code 5 different ways across the new checks and tests — reusing
an existing subscription, the pushSubscribeSchema payload shape, the
no-auto-permission-request guard, the disable() error swallowing, and the
`<script>` load order on every bell page — and a failing check or test caught
every one. The originals were restored byte-for-byte before packaging.

## Not verified

- **Real delivery and a real permission prompt:** everything here is tested
  against a fake `navigator.serviceWorker` / `Notification` in Node, the same
  limitation package 1 had for the service worker itself. That still needs
  HTTPS, real VAPID keys, and an actual device.
- **The bell row and Settings toggle's on-screen layout and 44px touch
  target**, in a real browser. Package 2B's checklist already includes "a
  real-browser check of the prompt layout and 44px touch targets" — I folded
  this package's own new UI into that same check rather than running a
  separate one now, so it still needs to happen before this ships.
- **Multiple tabs at once:** the `ns-push-state-changed` sync only covers
  bells within one page; two tabs open to different pages won't see each
  other's toggle flip until their own next status check.

## Package 2B will contain

- The soft pre-permission prompt, snoozed for 3 days, then 14 days.
- iPhone "Add to Home Screen" guidance (Safari doesn't support Web Push
  outside an installed PWA).
- Per-person consent copy alongside the prompt.
- Re-registering a device after a password change (today, `enable()`/
  `disable()` are the only two ways a subscription's server-side row
  changes; a changed password doesn't currently prompt re-subscription on
  its own).
- The real-browser layout/touch-target check covering both 2A's and 2B's UI,
  then the zip.

Say go and I'll start package 2B.
