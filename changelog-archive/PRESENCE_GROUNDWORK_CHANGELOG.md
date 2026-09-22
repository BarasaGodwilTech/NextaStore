# Round 11, step 2 — presence groundwork (checkpoint, NOT a finished feature)

Built on `NextaStore_PWA_checkpoint_round11_step1_new_product_follower_notify`.

**Read this first: real-time presence is not built yet.** This package contains
only the database groundwork. Nothing in the app reads the new column, so
there is no visible change and no behaviour change. It was packaged at this
point on request; the feature itself is the next step.

## What's in this package

- **`prisma/schema.prisma`:** `User.lastActiveAt DateTime?` — when a person
  was last seen connected. Only meaningful while they are offline. Nullable,
  so "never seen" is a real state the UI will show as plain Offline.
- **Migration `20260920100000_user_last_active_at`:** one statement,
  `ALTER TABLE "User" ADD COLUMN "lastActiveAt" TIMESTAMP(3);`. Nullable with
  no default, so it changes no existing row and does not rewrite the table.
  Deliberately not indexed: it is only ever read by primary key (a
  conversation's other party, a store's owner), and an index would only add
  write cost to a column that is updated often.

That is the entire diff against the step 1 checkpoint (plus this file).

## Verification

| Check | Result |
| --- | --- |
| `qa:static` (includes the migration-history replay guard, now replaying the new migration) | 90/90 |
| `test:seo` | 10/10 |
| `test:push` (all four sub-suites) | 48/48 + 27/27 + 32/32 + 30/30 |
| `test:new-product-notify` | 15/15 |
| `node --check` on every backend and frontend JS file | passes |
| Diff against the step 1 checkpoint | exactly `schema.prisma` and the new migration folder |

**Not verified:** the schema change was not run through `prisma validate`,
`prisma generate` or `migrate deploy` — `node_modules` and Postgres are not
available in this environment. The change is a single nullable column, but run
`npm run migrate:deploy` once before relying on it.

## Where each item in your spec actually stands

Found by auditing the checkpoint this session. Only the presence work was
started; the rest is what earlier rounds already delivered.

| # | Spec item | State in this checkpoint |
| --- | --- | --- |
| 1 | Real-time online/offline presence | **Not built.** Groundwork only (above). Messaging is currently poll-based (8 s). |
| 2 | Two-tier notification read state | **Built** in an earlier round: `acknowledgedAt` column, `PUT /notifications/acknowledge`, bell-open handler in `main.js`. Its own changelog says it has no automated tests. I did not re-audit the bell UI this session. The API exposes `readAt`/`acknowledgedAt`, not a literal `is_read` boolean. |
| 3 | Web Push + service worker | **Built** across the three push packages (service worker, backend, page-side subscribe, soft pre-permission prompt, iOS guidance). No real device has received a push; that needs HTTPS, real VAPID keys and a phone. |
| 4 | Mobile nav / hamburger overhaul, responsive tables | **Not audited this session.** Only a prior mention of safe-area / `100dvh` handling on the messages page. Needs its own look before anyone assumes it is done or not. |
| 5 | Dynamic payment methods | **Partly built:** `PaymentMethod` model, `GET /api/payments/methods`, admin CRUD, checkout fetches the catalog. **Still open** per its own changelog: the seller-side payment settings panel and the dashboard overview badges (`dashboard.js`, ~lines 387–390) are still hardcoded to three methods. Its changelog names `store-builder.*`, which Round 9 step 4 removed, so that panel probably now lives under Settings → Store — confirm. No automated tests. |
| 6 | Admin overhaul + RBAC | **Infrastructure exists, not audited:** 12-permission catalog, `AdminRole.permissions`, `requireAdminPermission`, super-admin bypass. Not checked: whether every admin endpoint is guarded, whether the UI omits (rather than disables) modules per role, or whether the four named roles exist as presets. No redesign started. |

## Presence design, decided but not implemented

Recorded so the next session doesn't re-derive it.

- **Transport: SSE read over `fetch()`, not `EventSource`.** Auth is a Bearer
  header and `EventSource` cannot send headers; a token in the URL would end
  up in the `morgan` request logs.
- **Presence traffic must count as "background" in `middleware.js`**
  (`isBackgroundRequest`), or a forgotten tab would renew its own session
  forever and defeat the inactivity timeout. That check is currently a path
  regex for the two `unread-count` routes and needs extending.
- **`server.close()` waits for open connections**, so `server.js` must close
  every presence stream on `SIGTERM`, or each deploy's shutdown hangs.
- **`compression()` is mounted globally:** the stream needs
  `Cache-Control: no-cache, no-transform` (compression skips those).
- **Multi-instance:** the codebase already uses Redis when `REDIS_URL` is set.
  Presence should follow the same pattern (in-memory by default, Redis sorted
  sets plus pub/sub when configured), with a dedicated subscriber connection.
  In memory-only mode, presence is per-instance, which must be logged the way
  `cache.js` already warns.
- **Flicker-free offline:** a ~15 s grace period after the last connection
  closes before announcing offline, so page navigations and brief reconnects
  don't blink the dot. Streams cap their own age (~4 min) and reconnect, which
  re-authenticates them; revocation call sites (password change, logout-all,
  suspension) should disconnect the person's streams immediately.
- **Who can see whom:** watch by `conversation:<id>` (only that conversation's
  two parties) or `store:<slug>` (public, published, active stores only)
  rather than by raw user id, so internal ids are never exposed and
  authorization is one query.
- **Redundancy:** include the counterpart's presence in the conversation-list,
  thread-open and 8 s since-poll responses, so the header is correct instantly
  and still converges if streaming is blocked by a proxy.
- **Frontend:** `js/presence.js` on every signed-in page (so people appear
  online wherever they are, not only on Messages); render from state rather
  than one-off DOM edits — the thread header is rebuilt by `innerHTML` on
  every poll; a page hidden for ~60 s disconnects, so a forgotten desktop tab
  doesn't read as online all day. Labels: Online / Active just now / Active
  5m ago / 3h ago / yesterday / 4d ago, and plain Offline beyond a week.
- **Suggested addition, not in your spec:** a "show my activity status"
  setting. Presence tells a counterpart when someone was last around, which
  some buyers will want to turn off.

## Environment notes for whoever continues

- **Chromium 141 and Playwright are available here**
  (`PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`), so real-browser tests are
  possible — the existing `push-sw-browser-test.js` can run.
- **Two existing tests pin the service-worker cache version to v7:**
  `scripts/push-sw-test.js` (~line 332) and `scripts/push-sw-browser-test.js`
  (~lines 113–115). The service worker's own comment says to bump
  `CACHE_VERSION` whenever cached JS/CSS changes, and presence will change
  several files, so those assertions need loosening to "v7 or later" (as
  `qa-static.js` already does) at the same time as the bump.
- `express` and `compression` are not installed here, so route tests use the
  fake-router pattern from `push-backend-test.js`; behaviour that depends on
  the real `compression` package can only be checked statically.
