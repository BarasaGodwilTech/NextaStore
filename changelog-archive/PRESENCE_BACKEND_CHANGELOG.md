# Round 11, step 3 — presence BACKEND (checkpoint, NOT a finished feature)

Built on `NextaStore_PWA_checkpoint_round11_step2_presence_groundwork`.

**Read this first: the server side of presence is built and tested; the
browser side is not.** Nothing in the pages calls the new endpoints yet, so
users see no change. There is no green dot, no "Active 5m ago", and
`js/presence.js` does not exist. The frontend is the next step.

## What's in this package

**New**
- `src/presence.js` — the presence engine (no HTTP in it). Tracks who has a live
  stream, announces online/offline to watchers, and saves `User.lastActiveAt`.
  - *Flicker-free:* offline is announced only after 15 s with no stream, so page
    navigations and brief reconnects never blink the dot.
  - *Last active:* written on going offline, plus a checkpoint every 3 min while
    online and on shutdown. Written with **raw SQL** so `User.updatedAt` (shown in
    the admin console as "last edited") is not bumped every few minutes.
  - *Limits:* 5 streams per person (a 6th replaces the oldest), 100 watches per
    stream, streams end themselves after 4 min so the client re-authenticates.
  - *Multi-instance:* in memory by default (boot logs a warning, like `cache.js`);
    with `REDIS_URL`, a per-user Redis hash with a 90 s TTL plus pub/sub, so an
    instance won't announce offline while another still holds the person.
- `src/routes/presence.js`
  - `POST /api/presence/stream` — server-sent events read with `fetch()` (auth is
    a Bearer header, which `EventSource` cannot send; a URL token would land in
    the morgan logs). Body: `{ "watch": ["conversation:<id>", "store:<slug>"] }`.
    Events: `snapshot` first, then `presence` `{ key, online, lastActiveAt, at }`,
    then `end` `{ reason }` (`reconnect` | `shutdown` | `session-ended` | `replaced`).
    Being connected *is* the caller's own presence. Keys, never user ids, go over
    the wire. Watches are fixed for a stream's life (open a new stream to change
    them), which keeps it stateless across instances. `at` lets the browser drop
    an event older than the state it holds.
  - `GET /api/presence/store/:slug` — public one-off status of a store's owner, for
    signed-out visitors and first paint. Never cached; 404 for unpublished,
    deleted or expired-trial stores.
  - *Who can see whom:* a conversation key resolves only for that conversation's
    two parties (one query is the authorization); a store key only for a public,
    published, in-window store. Anything else is dropped silently, so the endpoint
    can't be used to probe ids or slugs.

**Changed**
- `routes/messages.js` — conversation list, thread open and the 8 s since-poll now
  include the other party's `presence: { online, lastActiveAt }`, so a header is
  right instantly and still converges if streaming is blocked. Two extra small
  joins (owner / buyer `lastActiveAt`); no user ids added to responses.
- `middleware.js` — presence paths (any method) count as background traffic, so a
  forgotten tab cannot renew its own session through its stream. Exports
  `isBackgroundRequest`.
- `validation.js` — `presenceStreamSchema`.
- `app.js` — mounts `/api/presence`.
- `server.js` — `SIGTERM`/`SIGINT` and `uncaughtException` end every stream first,
  otherwise `server.close()` waits on them and each deploy hangs; 10 s force-exit
  as a backstop.
- `routes/auth.js` (logout-all, reset-password), `routes/user.js` (password
  change), `routes/admin.js` (suspend) — end that person's streams immediately.
  The original one-line `removeAllSubscriptionsForUser` statements are untouched
  (static checks pin them); the presence call sits on its own line.
- `package.json` — `test:presence`.

## Verification (run in this environment, and again from a fresh extract of the zip)

| Check | Result |
| --- | --- |
| `qa:static` (adds 9 presence checks) | 99/99 |
| `test:presence` (new) | 36/36 |
| `test:seo` | 10/10 |
| `test:push` (all four sub-suites) | 48/48 + 27/27 + 32/32 + 30/30 |
| `test:new-product-notify` | 15/15 |
| `node --check` on every backend and frontend JS file | passes |

`test:presence` runs the real `presence.js` and `routes/presence.js` with Express,
Prisma, config and Redis stubbed. It covers: grace period and cancel-on-reconnect,
last-active saving and preference, multi-tab, stream cap, ping and max age,
revocation, shutdown, watch authorization (own conversation, other side, stranger,
unknown, expired store), SSE headers and framing, no user ids on the wire, the
public store status, and the Redis fan-out logic.

## NOT verified — please check these

- **Real Express + `compression`.** Not installed here. `no-transform` is set and
  statically checked, but I have not watched a real stream get through the real
  middleware stack. First thing to try: run the server, `curl -N -X POST
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json"
  -d '{"watch":[]}' http://localhost:4000/api/presence/stream` and confirm a
  `snapshot` event appears immediately and a `: ping` every 20 s.
- **The raw SQL.** `UPDATE "User" SET "lastActiveAt" = $1 WHERE "id" IN (...)` via
  `$executeRaw` with `Prisma.join`. Written to the documented API but never run
  against Postgres. Failures are caught and logged as
  `[presence] could not save last-active time`, so a mistake won't break
  anything, but "Active 5m ago" would silently never appear.
- **The Redis path.** Tested only against a hand-written fake that implements the
  handful of ioredis calls used (`pipeline`, `hset`, `hgetall`, `hdel`, `expire`,
  `publish`, `duplicate`, `subscribe`). That proves my logic, not ioredis.
- **`prisma validate` / `migrate deploy`** for the step 2 column — still needed:
  run `npm run migrate:deploy` once before relying on `lastActiveAt`.
- **Load.** One open stream per visible tab is one socket held open. Nothing here
  has been load-tested; Node handles thousands, but check the platform's
  connection and idle-timeout limits (pings go out every 20 s).

## Still to build for presence (in order)

1. `js/presence.js` — fetch-based SSE client with an incremental parser; state map
   with `at` ordering; render from state via `data-presence-key` attributes
   (the thread header is rebuilt by `innerHTML`); backoff reconnect; disconnect
   after ~60 s hidden; reconnect on `pageshow`, `online` and `end: reconnect`;
   stop on 401/403 and on `end: replaced`; REST payloads seed state only when the
   stream is not healthy. Labels: Online / Active just now / Active 5m ago /
   Active 3h ago / Active yesterday / Active 4d ago, and plain Offline past a week.
2. Load it on every signed-in page (after `ui-overlays.js`; `qa-static.js` pins the
   `main.js` → `push.js` → `push-prompt.js` order, which this keeps).
3. Green/gray dots and the status line in `messages.js` (conversation rows and thread
   header) and `store-detail.js` (seller header, using `GET /presence/store/:slug`
   for signed-out visitors); styles in `main.css`.
4. Bump `CACHE_VERSION` to v8 in `service-worker.js` and loosen the two tests pinned
   to v7 (`push-sw-test.js` ~line 332, `push-sw-browser-test.js` ~lines 113–115) to
   "v7 or later", as `qa-static.js` already does.
5. Browser test (Chromium and Playwright are available here).
6. **Suggested, not in your spec:** a "show my activity status" setting. Presence
   tells a counterpart when someone was last around; some buyers will want that off.
   It needs one more column and a check in `describe()`.

## Other spec items — unchanged since the step 2 audit

Web Push built (no real-device test); two-tier notifications built (no automated
tests); dynamic payments partly built; admin RBAC infrastructure exists, unaudited;
mobile nav not audited. See `PRESENCE_GROUNDWORK_CHANGELOG.md` for detail.
