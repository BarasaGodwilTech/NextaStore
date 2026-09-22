# Web Push — Package 2B: soft prompt, iOS guidance, consent copy, credential re-registration

Package 2A (`PUSH_NOTIFICATIONS_CHANGELOG_PART2A.md`) shipped the plumbing
(`js/push.js`) and two on-demand ways to turn push on: the bell's "Turn on"
row and the Settings toggle. Neither ever asks anybody to do it — a person
has to go find one of them first. This package is everything that was left
proactive: a banner that offers on its own, iPhone guidance for the one
platform where "just click enable" doesn't apply, and a fix for the one way
a working subscription could silently go stale on its own.

## What's in this package

- **`js/push-prompt.js` (new file):** the soft pre-permission prompt.
  - Shows a dismissible bottom banner — headline, one line of consent copy
    ("hear about new messages, order updates and price drops... you can turn
    it off anytime in Settings"), a **Turn on** button and a **Not now**
    button — a couple of seconds after a signed-in page loads.
  - **Never calls the browser's own permission API.** Clicking **Turn on**
    calls the real `NextaPush.enable()` from package 2A, which is what
    triggers the native dialog. This file's only job is to ask first, in the
    app's own words.
  - Stays quiet whenever there's nothing to usefully offer: signed out,
    permission already granted or denied, this device already subscribed,
    the server not configured for push, or the person snoozed it.
  - **Snooze escalates:** dismissing once hides it for 3 days; every
    dismissal after that hides it for 14. A denied permission isn't snoozed
    on top of that — `permission() !== 'default'` already keeps it from
    reappearing, so there's nothing to add.
  - Disappears immediately if the device gets subscribed some other way
    while it's open (the bell's own row, another tab), via the same
    `ns-push-state-changed` event package 2A already dispatches.
- **iPhone "Add to Home Screen" guidance**, same file, same banner
  component, different content: when the browser is Safari on an iPhone/iPad
  that hasn't been added to the home screen, `NextaPush.supported()` is
  false (no `PushManager` outside an installed PWA) and the enable banner
  would have nothing to offer. This variant explains Share → "Add to Home
  Screen" instead. Gated on iOS 16.4+ (parsed from the UA string) — Web Push
  for installed apps didn't exist before that, so there's nothing honest to
  tell someone on an older iPhone.
- **`js/push.js` gains `reregisterAfterCredentialChange()`:** a password
  change bumps `tokenVersion` and drops every push device row server-side
  (package 1's own rule, unchanged) — but the browser's own `PushSubscription`
  is never touched by that. Without this, a device stayed subscribed in the
  browser while silently receiving nothing, until someone noticed and dug
  back through Settings. Now `js/dashboard.js` calls it once, right after a
  successful password change, with the fresh token already in place. Silent
  either way: no permission prompt, no visible error — the bell and Settings
  toggle already show accurate status on their own.
- **`js/push-prompt.js` is now loaded on the same 15 pages as `js/push.js`**
  (admin, cart, dashboard, favorites, following, index, marketplace,
  messages, onboarding, orders, product-detail, product-form, store-detail,
  stores, subscription), immediately after it.

## Verification

| Suite | Result |
| --- | --- |
| `qa:static` (16 new package-2B checks) | 78/78, was 62/62 |
| `test:seo` | 10/10 |
| `push-sw-test` (unchanged this round) | 48/48 |
| `push-backend-test` (unchanged this round) | 27/27 |
| `push-page-test` (unchanged this round) | 32/32 |
| **New:** `push-prompt-test.js`, fake browser, real `js/push.js` + `js/push-prompt.js` loaded together (`npm run test:push-prompt`, now part of `npm run test:push`) | 30/30 |

I broke the new code 3 different ways — flattening the 3-day/14-day snooze
escalation to always 3 days, dropping the iOS 16.4 version gate, and
snoozing a denied permission on top of the permission check that already
covers it — and a failing check caught every one before the original was
restored byte-for-byte.

## Not verified

- **Real device / real browser check of both banners' on-screen layout and
  44px touch targets**, and an actual iPhone walking through Share → Add to
  Home Screen → a real permission prompt. Everything above is tested against
  a fake DOM/navigator/localStorage in Node, same as every other push
  package — that's fast and deterministic but can't see actual layout,
  actual Safari quirks, or an actual push arriving on an actual lock screen.
  I looked at running `scripts/push-sw-browser-test.js`'s real-Chromium setup
  (Playwright) to at least cover the desktop banner, but this environment's
  network is restricted to package registries and GitHub — it can reach
  `registry.npmjs.org` to install the `playwright` package itself, but not
  the separate browser-binary download Playwright needs afterward, so I
  couldn't run it from here. This still needs to happen on a machine with
  fewer network restrictions before shipping.
- **Multiple tabs at once**, still the same limitation package 2A noted:
  `ns-push-state-changed` only syncs bells within one page.

## Where this leaves the push notification feature overall

Between package 1 (server + service worker), 2A (page-side subscribe
plumbing) and this package, every item on the original push notification
checklist is implemented and covered by an automated suite except the
real-device check above:

- [x] Service Worker push listener, Web Push API + VAPID
- [x] Non-intrusive UI prompt before the browser's own permission request
- [x] Background notifications with tap-through to the right chat/order/alert
- [ ] Real-device confirmation of the above (blocked on this environment's
      network access to a browser binary, not on anything left to build)

Say the word if you'd like me to try the real-browser pass again in an
environment that can reach a Chromium download, move on to the next feature
from the original list (real-time presence, the two-tier notification read
states, dynamic payment methods, or the admin RBAC overhaul), or something
else entirely.
