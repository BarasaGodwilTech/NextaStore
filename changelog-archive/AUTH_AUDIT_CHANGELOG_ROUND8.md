# Auth / session audit — round 8 (IN PROGRESS checkpoint)

Four steps so far. Findings 1-7 and section C are done. Step 4 was the first
time any of it ran in a real browser: it confirmed most of steps 1-3, found five
real defects in the step 3 code (plus one defensive change that could not be
reproduced) and fixed them - see "Step 4" below,
including the list of what is STILL not verified (real Postgres, the real
Express routes, browsers other than Chromium). Where the older per-step
"Testing" sections below say "NOT run in a real browser", read them together
with Step 4: it supersedes them for everything its table marks verified.

## Done in this checkpoint

Finding 5 (no absolute cap; polling counted as activity) — backend part
- `src/config.js`: every session now has an inactivity window AND an absolute cap.
  - plain login: 2d inactivity, 7d cap (`JWT_SESSION_EXPIRES_IN`, `JWT_SESSION_MAX_AGE`)
  - remember me: 30d inactivity, 90d cap (`JWT_REMEMBER_EXPIRES_IN`, `JWT_REMEMBER_MAX_AGE`)
  - admin: 1h inactivity, 12h cap, never "remember me" (`JWT_ADMIN_EXPIRES_IN`, `JWT_ADMIN_MAX_AGE`)
- `src/middleware.js`:
  - tokens carry `at` (original password-login time); renewals copy it forward and
    `exp` is clamped to `at + cap`, so use can never extend a session past the cap
  - renewal is skipped for background polls (`X-Background-Poll: 1` header, and the
    two `/unread-count` endpoints by path so already-cached old clients are covered)
  - no pointless renewals near the cap

Finding 6 (revocation) — verification side only
- tokens carry `tv`; `userFromAuthHeader` rejects with `401 TOKEN_REVOKED` when it
  differs from `user.tokenVersion`. Missing on either side counts as 0, so nothing
  is logged out by deploying this. The `tokenVersion` column, the bump on
  password change/reset and "log out everywhere" are NOT added yet.

Finding 7 — database errors during auth now return `503 SERVICE_UNAVAILABLE`
instead of `401 TOKEN_INVALID` (which made the browser wipe the login).

Also: `jwt.verify` pinned to HS256; `Cache-Control: no-store` + `Vary: Authorization`
on authenticated responses; 413 gets a readable message.

Signature change: `signSessionToken(user, rememberMe, authTime)` now takes the
user object (needs `id`, `role`, `tokenVersion`), not an id. `routes/auth.js` and
`authtest.js` are updated.

## Step 1 — findings 1 and 4 (browser side)

Finding 1 — unvalidated `?redirect=` (`js/auth.js`)
- After login, the `redirect` value is only followed if it is a plain page name in
  this site (`something.html`, optional `?query` / `#hash`). `https://…`, `//host`,
  `javascript:…`, paths and `..` are all ignored; the person lands on their role's
  home instead.
- Ignored if the new person's role can't open that page (seller-only pages,
  `admin.html`) and never points back into login/signup/forgot-password.
- If the redirect exists because a session just ended (`?reason=`), it is only
  honoured for the SAME person whose session ended. Whoever signs in next goes to
  their own home. The ended session's user id is kept in sessionStorage.
- `npm run qa:static` now fails if the page lists in `auth.js` drift from the
  `data-seller-required` / `data-admin-required` attributes in the HTML.

Finding 4 — previous person's data left behind (`js/main.js`, new `SessionData`)
- All user-specific storage is listed in one place and tagged with an owner id.
  Signing in (or loading a page with a session) as somebody other than the owner
  wipes the previous owner's cart and unsent messages first. No owner yet (a
  guest's cart) is adopted, so guest -> login -> checkout still works.
- One `endSession(reason)` now handles logout, expiry, revoked and suspended.
  Explicit "Log out": clears cart, unsent messages and pending action, forgets the
  owner. Session ended on its own: keeps cart and unsent messages for the same
  person (still owner-tagged) and drops the pending action.
- BEHAVIOUR CHANGE: "Log out" now empties the cart on this device. Expiry does not.
- Unsent messages (`js/messages.js`) are stamped with the sender's id and only
  shown to that sender, so the other party in a conversation can never see (or
  Resend as themselves) somebody else's unsent text. Old unstamped entries are ignored.
- Notification preferences (`js/dashboard.js`) are stored per user
  (`nextastore_notification_prefs:<userId>`). The old shared key is deleted on wipe.

Pulled forward because they sit in the same code:
- `apiRequest` now ends the session on `TOKEN_REVOKED` (401) and `ACCOUNT_SUSPENDED`
  (403) as well as expired/invalid. Before, a revoked token would have left the
  browser stuck on errors. A 503 still keeps the login.
- `login.html` shows why you were sent there (`?reason=expired|revoked|suspended`).
  It was sent before but never read.
- `signup.html` now has the `data-signup-page` flag `auth.js` checks, so a logged-in
  visitor is sent away from signup.
- `service-worker.js` cache bumped v3 -> v4 so returning visitors get the new JS.

## Testing for step 1
- `node --check` passes on every changed JS file; `npm run qa:static` 40/40.
- NOT yet run in a real browser. The redirect rules and wipe behaviour have not
  been exercised end to end. Do that before relying on this.

## Step 2 — finding 6 fully, plus reset/limiter/validation hardening

This step is backend-only. Findings 2 and 3 (stale-tab overwrite, login/signup
loading the old session), the client idle timer, and `X-Background-Poll` on
`messages.js`'s poll loop are still NOT done — see "Not done yet" below,
carried forward unchanged from step 1.

Finding 6 (revocation) — now complete, not just verification-side
- `prisma/schema.prisma`: `User.tokenVersion Int @default(0)`, plus a migration
  (`20260919120000_user_token_version`). Every existing row defaults to 0,
  same as a token with no `tv` claim — deploying this alone logs nobody out.
- `POST /auth/logout-all` (new, `requireAuth`): increments `tokenVersion`,
  which invalidates every token for that user, including the one the request
  itself was authenticated with. Wired to a new "Log out of all devices"
  button in dashboard.html's Account Settings.
- Password reset (`POST /auth/reset-password`) and self password-change
  (`PUT /user/me`) both bump `tokenVersion` now too — resetting or changing a
  password ends every other session, which is the actual point of finding 6,
  not just having a button for it.
- Self password-change is the one case that bumps `tokenVersion` while ALSO
  needing the current device to stay logged in, so `PUT /user/me` re-signs
  and returns a fresh token in that case; `dashboard.js` adopts it. Skipping
  this would have logged people out of their own device the moment they
  changed their own password.

Bug found and fixed in the same code: `dashboard.js`'s account-settings form
never had a "Current password" field, so `PUT /user/me`'s
`if (!payload.currentPassword ...)` check meant changing your password from
Account Settings has been unconditionally failing with "Current password is
incorrect" — probably since this form was built. Added the missing field.

Finding C (login timing / brute force)
- Login now runs `bcrypt.compareSync` against a fixed dummy hash when the
  email doesn't exist, instead of skipping the (slow) bcrypt call — a
  registered and an unregistered email now take the same time, closing the
  email-enumeration-by-timing gap.
- Login now rejects a suspended account itself (`403 ACCOUNT_SUSPENDED`)
  instead of only discovering it on the next authenticated request.
- `authLimiter` (per IP) now uses `skipSuccessfulRequests`, so successful
  logins on a shared IP no longer eat into the same budget as failed ones.
- New `perEmailLoginLimiter`: a second, per-normalized-email bucket (10 /
  15 min, also `skipSuccessfulRequests`), so guessing one account's password
  from many IPs is still capped even though the per-IP limiter resets for
  each new source address.
- `rememberMe: z.coerce.boolean()` is replaced with a small preprocessor
  (`looseBoolean`) that treats the strings `"false"`/`"0"`/`""` as false —
  `z.coerce.boolean()` ran every non-empty string through `Boolean()`, so the
  literal string `"false"` came out `true`.
- Signup/login/reset/self-change passwords now require 8 characters (was 6).
- `verification.js`: `redeemToken` is now a single atomic `updateMany` guarded
  on `usedAt: null`, closing the find-then-update race where two requests
  racing the same still-valid token (a double-tapped submit, a retry) could
  both pass the check and both succeed. `issueToken` now also retires the
  requester's other not-yet-used tokens of the same type, so requesting a
  second reset/verification link invalidates the first instead of leaving
  two valid links outstanding at once.

## Testing for step 2
- `node --check` passes on every changed backend and frontend JS file.
- `npm run qa:static` 40/40 (unchanged from step 1 — nothing here touches
  what it checks).
- NOT run against real Express/Prisma/Postgres, and NOT run in a browser.
  The migration has not been applied to a real database. Run
  `npx prisma migrate deploy` (or `migrate dev` locally) before relying on
  `tokenVersion` — until then, `payload.tv` and `user.tokenVersion` are both
  always 0/undefined and revocation is a no-op, same as before this step.

## Not done yet
- Section C items not covered by any step so far: none — every item from the
  original audit's section C has now been addressed across steps 2 and 3.

## Step 3 — findings 2 and 3, the idle timer, and X-Background-Poll

Finding 2 (stale tab overwrites a newer login) — `js/main.js`
- `adoptRenewedToken(response, requestToken)` now takes the token the
  request was actually made with. It only adopts a renewal when that token
  is STILL both the active in-memory session AND what storage currently
  holds — a slow response from a stale tab, or a request that was in flight
  when the session changed, can no longer overwrite whatever session exists
  now.
- The same `requestToken` check gates ending the session on a 401/403: a
  late auth failure for an OLD token no longer wipes out a session that has
  since changed.
- New `setupCrossTabSync()`: listens for the browser's own `storage` event
  (fires in every OTHER tab when localStorage changes, never the tab that
  made the change, and never for sessionStorage — which is already per-tab).
  On any change to `nextastore_token`/`nextastore_user`, reloads the page
  rather than trying to patch a live page's auth state, cached role, and
  open polls in place.
- `checkAuthState()` now checks the token's own `userId` claim against the
  cached `nextastore_user` record on every load; a mismatch (the stale-tab
  race caught mid-write) ends the session instead of letting the page act as
  whichever half happened to load first.

Finding 3 (login/signup load the previous session) — `js/main.js`, `js/auth.js`
- `checkAuthState()` now returns immediately on any `data-auth-page` page
  (login, signup, forgot-password, verify-email) once the expiry/mismatch
  checks above have run, before ever calling `loadUserData()` or starting
  badge polling.
- `auth.js`'s `AuthManager.init()` now redirects an ALREADY-logged-in visitor
  away from both login.html and signup.html (previously only signup.html),
  reusing the same `safeRedirect()` the real login flow uses so a
  `?redirect=` is still honoured.

Client idle timer (finding 5's third bullet) — `js/main.js`
- New `startIdleTimer()`, started for any signed-in visitor on a
  `data-auth-required` page (not on `data-auth-page` pages, which have
  nothing to be idle in). Tracks real input (`pointerdown`, `keydown`,
  `wheel`, `touchstart`) and ends the session after 30 minutes of none,
  independent of the token's own expiry — this is a "walked away from an
  open tab" guard, not a session-length policy. Does not fire while the tab
  is hidden (that's "not visible", not "idle").

`X-Background-Poll` sent by the client (was server-honoured only) —
`js/main.js`, `js/messages.js`
- The two unread-badge pollers (`refreshNotificationBadge`,
  `refreshUnreadBadges`) now send the header explicitly, rather than relying
  on the server's path-based fallback for those two specific endpoints.
- `messages.js`'s own 8s poll loop — `loadConversations({ preserveLoaded })`
  and `pollActiveThread()` — now sends it too. These hit
  `/messages/conversations` and `/messages/conversations/:id`, neither of
  which matched the server's `BACKGROUND_PATH` pattern, so before this
  change an open (visible, focused) message thread would silently keep
  sliding a session's expiry forward forever on its own poll, exactly the
  "polling counts as activity" problem finding 5 was about — just via a
  different endpoint than the ones already covered.

Section C — the two left from step 2
- `express.json({ limit: '50mb' })` is now two parsers: a 20MB one mounted
  only on `/api/user`, `/api/store`, `/api/products` (the routes that
  actually save base64 images), and a 100KB default for everything else,
  auth included. body-parser skips re-parsing a body its own type already
  consumed (`req._body`), so mounting the generous one first and the small
  one second works without double-reading the request. Note: `/api/products`
  also carries the public, unauthenticated `GET /products/public` and
  `/products/deals` — those still sit behind the 20MB parser rather than
  100KB, since the split is per path prefix, not per route; still a 60%
  reduction from the original ceiling, not a full fix for that specific
  pair of endpoints.
- `forgot-password.html` and `verify-email.html` both strip `?token=` from
  the address bar with `history.replaceState` right after reading it, before
  the token is used.

## Testing for step 3
- `node --check` passes on every changed file (`js/main.js`, `js/auth.js`,
  `js/messages.js`, `nextastore-backend/src/app.js`).
- `npm run qa:static` 40/40.
- NOT run in a real browser. In particular: the cross-tab `storage` listener,
  the idle timer's 30-minute wait, and the stale-response `requestToken`
  guards are exactly the kind of timing-dependent behavior that's easy to
  get subtly wrong and needs to be watched happen in two real tabs before
  trusting it — see "What step 4 should actually test" below.

## Step 4 — real-browser verification, and what it found

How it was tested
- New: `nextastore-backend/scripts/auth-browser-tests/` - run with
  `npm run test:auth-browser` (needs `npm i --no-save playwright && npx playwright install chromium`
  once; Playwright is deliberately NOT added to package.json so the lockfile stays in sync).
- Real Chromium 141 drives the REAL frontend files. The server side is the REAL
  `src/middleware.js` and `src/config.js` (signing, sliding renewal, absolute cap,
  revocation, the background-poll rule) behind a small stand-in HTTP server.
- Stand-ins: the database (in-memory users instead of Prisma), the route handlers
  (login, logout-all, fake conversations) and, in the offline sandbox this was
  built in, `jsonwebtoken`/`dotenv` (tiny shims that Node only uses if the real
  packages are absent).
- Time is faked on both sides (Playwright's clock in the browser, `/__test/advance`
  on the server), so "30 minutes idle" or "a 16-day-old token" takes seconds.
- Each scenario includes a positive control where a pass could be vacuous (e.g. a
  real request DOES renew a past-halfway token, so "polls don't renew" means something;
  the flash-detector DOES see the login form for a signed-out visitor).

Result: the final suite (54 checks) run against the original step 3 code = 46/54.
Against this checkpoint = 54/54, three runs in a row. `qa:static` 40/40.

Confirmed working as step 3 claimed (no change needed)
- Signed-in visitor on login.html/signup.html is redirected before the form is
  ever visible, even with 600ms of simulated latency; `?redirect=` honoured only when
  safe (off-site, `//host`, wrong-role and stale `reason=expired` redirects ignored).
- Expiry -> login page with the reason shown; the same person is returned to their
  page, a different person is not.
- Sign out in one tab moves the other tab to login; a different person signing in
  next is followed by the other tab, and the previous person's cart is gone.
- A tab that MISSED the storage event and later receives a renewed token does not
  overwrite the newer person's session (the core of finding 2).
- The 30-minute idle timer fires, and real input resets it.
- Message-thread and badge polls all carry `X-Background-Poll`, none renew the
  session, and a tab with only polling still dies on the token's own schedule.
- "Log out of all devices" (finding 6): the other device's next request gets
  `401 TOKEN_REVOKED`, lands on login with the explanation, and can sign in again.

Bugs found and fixed in this step
1. Idle timer died for good after one hidden check (`js/main.js`). `check()` returned
   without rescheduling itself when `document.hidden`, so the first 60s check that
   landed while the person was on another tab stopped the timer permanently.
   Now it keeps ticking; hidden only postpones the decision, and returning to the tab
   re-checks immediately.
2. Idle timer signed out an actively-used window (`js/main.js`). Each tab timed
   itself, but the login is shared: an untouched second window ended the session at
   30 minutes and cleared the shared login, kicking the window in use to login.
   Input in any tab now counts (published to localStorage as `ns_last_activity`,
   stamped with the user id, ignored for anyone else). Verified it does not become
   "never idle": both windows still end ~30 min after the last input in either.
3. Stale tab's profile refresh could cause a logout (`js/main.js` `loadUserData`).
   It wrote the old person's user record next to a newer person's token if the session
   changed while `/user/me` was in flight; the next page load's token/user mismatch
   check then ended the newer person's valid session. Now it only writes if the
   session is still the same PERSON (compared by user id, not token string, because
   a renewal can legitimately swap the token during that very request).
4. Renewal in one tab reloaded the same person's other tabs (`js/main.js`
   `setupCrossTabSync`). Any token change reloaded every other tab, including plain
   routine renewals - losing an unsent message or half-filled form. Same-person token
   changes are now adopted quietly (only for a session already in localStorage);
   sign-out or a different person still reloads.
5. Poll fallback renewed the session (`js/messages.js`). When a poll lost its cursor
   or the gap was too big, it reloaded the whole thread through
   `openConversation(id, {silent:true})`, which sent no background header. It now
   passes `background: true` from those two call sites.
6. Defensive, NOT reproduced (`js/auth.js`): login/signup now write the user record
   before the token, so a tab that reloads on the token event never sees one person's
   token beside another's record. The window is a few microseconds and could not be
   provoked in a test; this is a two-line reorder, not a verified fix.

Also: `service-worker.js` cache v4 -> v5 (JS changed). `npm run test:auth-browser` added.

Test-tooling note
- Playwright's `page.waitForURL()` reported false timeouts when a page did two
  navigations back to back (storage-event reload, then redirect to login) even though
  the app reached the right URL within ~300ms every time. Instrumented and confirmed:
  the app was never flaky. The runner now polls the real URL instead.

Still NOT verified
- Real Postgres / Prisma: `npx prisma migrate deploy` has never been run;
  `tokenVersion` is a no-op until it is. The real `routes/auth.js` (logout-all,
  password change re-sign, reset, login limiter) was read but not executed - the tests
  use a stand-in for those routes. Real bcrypt, Express, express-rate-limit and the
  two-parser body-size split in `app.js` were not run either.
- Browsers other than Chromium 141. Safari/iOS and the installed PWA in particular
  (storage events, bfcache, and the home-screen app keeping its own storage separate
  from Safari) are untested. Firefox untested.
- The "Log out of all devices" BUTTON was not clicked; the test runs the same calls
  its handler makes (`POST /auth/logout-all` then `endSession('logout')`).
- "Hidden tab" is simulated by overriding `document.hidden`, not a genuinely
  backgrounded tab. "Tab missed the storage event" is simulated by suppressing the
  listener, not a genuinely frozen/discarded tab.
- The real Railway/ngrok setup, and real elapsed time (all long waits are faked clocks).

Decisions for you (behaviour, not bugs)
- Coming back to a tab that was hidden for more than 30 minutes now signs you out
  immediately (input is the only thing that counts as "not idle"). That is the
  usual idle-timeout behaviour and what the original comment intended, but someone
  who reads in another tab for 40 minutes will find themselves logged out on return.
  The limit is one constant (`IDLE_LIMIT_MS` in `startIdleTimer`).
- A token/user mismatch on page load still ends the session (as the audit
  recommended). Step 4 removed the ways found to CREATE a spurious mismatch, but the
  reaction is still "sign out". A gentler option is to discard the cached user and
  re-fetch `/user/me` with the token (the token is what the server trusts).

## Testing (step 0 — the checkpoint before this file existed)
Middleware logic smoke-tested with a throwaway HS256 shim (cap, revocation, 503,
alg pinning, renewal rules): 17/17 passed. NOT run against real Express,
jsonwebtoken, Prisma or Postgres.

## Housekeeping
The `.env` from the previous zip is deliberately NOT included here, and
`.gitignore` files now exclude `.env` and `node_modules`. If the previous zip left
your machine, rotate the Railway `DATABASE_URL` and `JWT_SECRET`.
