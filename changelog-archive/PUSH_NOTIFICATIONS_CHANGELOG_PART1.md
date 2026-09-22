# Push notifications — package 1 of 2 (service worker + server)

Built on `NextaStore_PWA_checkpoint_round9_step8_push_backend`.

Package 1 is everything that runs on the server and inside the service worker.
Package 2 is the page side (`js/push.js`). **Until package 2 is in, no browser
asks for permission or subscribes, so no device receives a push yet.**

## Changed

**`service-worker.js`** (cache `v6` → `v7`)
- `push`: always shows a visible notification, even for empty, non-JSON, array or
  wrong-typed payloads (iOS revokes subscriptions that show nothing). Title/body
  length-capped. Uses the brand icon plus a monochrome badge.
- Messages replace each other per conversation (tag `ns-msg-<id>`, renotify on).
  Orders and alerts are untagged so they stack — every order links to
  `dashboard.html#orders` and would otherwise overwrite one another.
- `notificationclick`: re-validates the link (same origin, `/` or `/<name>.html`
  only — anything else opens the app home), reuses an open window (exact page
  first, then visible, then any), focuses without reloading if already there,
  falls back to `openWindow` if `focus()`/`navigate()` reject.
- `pushsubscriptionchange`: re-subscribes with the old key and passes the result
  to an open page (`ns-push-subscription-changed`). Safari never fires this.
- Open pages get `ns-push-received` on every push so the bell can refresh.
  (Nothing listens for either message until package 2.)
- New asset: `assets/brand/png/badge/badge-96.png` (white N on transparent).

**`nextastore-backend/src/push.js`**
- `sendPushToUser` now resolves `{ devices, sent, failed, removed }` (existing
  fire-and-forget callers ignore it; still never throws).
- Messages carry a 24 h TTL (web-push's default is 4 weeks).
- New `removeAllSubscriptionsForUser(userId)`.

**`nextastore-backend/src/routes/push.js`**
- New `POST /api/push/test`: authenticated, sends only to the caller's own
  devices, 30 s cooldown per person (`429` + `Retry-After`; a send that reached
  nothing doesn't start it), `503` if VAPID keys aren't set, `409` if the person
  has no registered device.

**Push devices are now removed when sessions end** — *not in your request; added
because those paths end the logins but not the phone's subscription, so previews
would keep appearing on a signed-out lock screen:*
- `POST /auth/logout-all`, `POST /auth/reset-password`, `PUT /user/me` (only when
  the password changed), and admin suspension (`PUT /admin/users/:id`, only on the
  active → suspended transition).

**Tests / packaging**
- `scripts/push-sw-test.js` (48 checks), `scripts/push-backend-test.js` (27),
  `scripts/push-sw-browser-test.js` (20, real Chromium), 9 new checks in
  `scripts/qa-static.js`.
- `package.json`: `test:push`, `test:push-browser`. README: "Web Push" section.

## Verified

| Check | Result |
| --- | --- |
| `qa-static` | 49/49 (was 40/40 before this package) |
| `seo-test` | 10/10 |
| `push-sw-test` | 48/48 |
| `push-backend-test` | 27/27 |
| `push-sw-browser-test` (Chromium 141, pushes injected via DevTools) | 20/20 |
| `node --check` on every JS file | passes |
| Mutation check: 17 deliberate breakages (untagged messages, dropped origin check, orders tagged by link, empty push swallowed, unchecked click URL, broken offline fallback, caches not cleaned, missing TTL, `/test` sending to another user, etc.) | every one caught by a failing test; originals restored byte-for-byte |

## Not verified

- **No real phone has received a push.** That needs HTTPS, real VAPID keys and
  package 2. Tapping a notification can't be automated in any browser; the
  routing is tested against a fake worker, not a real tap.
- **Routes were not run under Express or against Postgres.** `node_modules` and a
  database weren't available, so the backend test stubs express/Prisma/web-push
  and runs the real `push.js` and the real `/test` handler logic. Mounting,
  real Prisma queries and the four revocation call sites are covered only by
  `node --check` and static source checks. Hit `POST /api/push/test` once after
  deploying.
- **Expired sessions** can't unsubscribe their own device (their token is
  already invalid). Package 2's orphan cleanup handles it when the next person
  signs in on that phone; until then it can keep showing previews.

## Package 2 (next)

`js/push.js` on the 14 app pages: soft prompt before the browser dialog (snooze
3 → 14 days), subscribe/unsubscribe, Settings → Notifications switch + "Send a
test", bell "Turn on" row, iOS Home Screen guidance, per-person consent, logout
detach, re-register after a password change; then the real-browser check of the
prompt and a final zip.
