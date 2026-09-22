# Messages flow — round 2: security + scale audit

Files touched: `js/main.js`, `js/messages.js`,
`nextastore-backend/src/routes/messages.js`,
`nextastore-backend/prisma/schema.prisma` (comment only, no schema change),
and one new migration:
`nextastore-backend/prisma/migrations/20260918110000_message_unread_perf_index/`.
Drop them into your project at the same paths — they replace the existing
files. Run `npx prisma migrate deploy` (or `migrate dev` locally) to apply
the new index.

## 1. Fixed: stored XSS via `escapeHtml()` not encoding quotes
**Severity: high.** `app.escapeHtml()` — used everywhere in the app, not
just this page — was implemented as `div.textContent = str; return
div.innerHTML`. Per the HTML serialization spec, that round-trip escapes
`& < >` but **never** `"` or `'`, because quotes only matter inside an
attribute value, not inside text content. The bug: this helper's output is
routinely dropped straight into `attr="${app.escapeHtml(x)}"` template
strings before an `innerHTML` assignment — an attribute context. The
clearest exploitable path was the shared-location card: `messageContentHtml`
builds `data-label="${label}"` from a location's free-text `label` field (up
to 200 characters, settable by either party via "share your location").
A label containing `x" onmouseover="alert(document.cookie)` would close the
attribute early and inject live markup/JS into whoever's thread renders that
message — a real stored-XSS vector, not just a theoretical one.

**Fix:** `escapeHtml()` now also encodes `"` → `&quot;` and `'` → `&#39;`,
so the same escaped value is safe in both text-node and attribute-value
contexts — which is what every call site in this codebase actually needs.
This is a one-file fix that closes the gap app-wide, not just on this page.

## 2. Fixed: message send blocked on a notification write it didn't need to wait for
Both `POST /messages` (new conversation) and `POST /messages/conversations/:id`
(reply) `await`ed `createNotification(...)` before responding.
`createNotification` already catches and logs its own errors — nothing in
either route branches on its result — so the `await` bought nothing but a
second sequential DB round trip of latency on the single hottest path in
this feature. Changed to fire-and-forget; the notification write now
happens concurrently with building the response instead of before it.

## 3. Added: index for unread-message lookups
The unread badge (polled every 20s from every logged-in page's nav, not
just this one) and the per-conversation unread count both filter
`Message` rows on `readAt IS NULL`, scoped to a user's conversations — with
no index covering that filter. Postgres had to scan every message in a
thread (or, for the global badge, every message across every conversation
a user belongs to) to find the handful that are actually unread, a cost
that grows with total message history in the wrong direction as the
platform grows.

Added a **partial** index — `(conversationId, senderId) WHERE readAt IS
NULL` — so only unread rows are ever in the index; it stays small and fast
regardless of how many millions of already-read messages pile up.

**Note on schema.prisma:** this index is deliberately *not* declared via
`@@index` in the Prisma schema — only documented in a comment. Prisma's
schema DSL can't express a partial index's `WHERE` clause, and declaring a
same-named full index would make Prisma's drift detection "fix" the real
partial index by replacing it with a full one on the next `prisma migrate
dev`. (This already happened once in this codebase — see
`20260917190000_restore_trigram_search_indexes` — so this round repeats the
same safe pattern used there instead of the mistake that preceded it.)
`prisma migrate deploy` in production doesn't run drift detection and is
unaffected either way.

## 4. Added: incremental ("since") polling — the main scale fix
**This is the one that matters most for growing user counts and heavy
concurrent usage.** Previously, the 8-second poll loop, for any open
thread, re-requested and the client fully re-rendered the most recent up
to 100 messages from scratch — every tick, for every open thread,
regardless of whether anything had actually changed. That cost is
per-open-thread and constant, so it scales linearly with concurrent active
users, not with actual message activity — exactly backwards for a growing
platform.

`GET /messages/conversations/:id` now accepts a `since` query parameter
(alongside the existing `before`, unchanged, for "load older messages").
`since` returns only messages newer than that timestamp, capped at 200,
plus any read-receipt flips on the current user's own messages that
happened in that window (needed because the existing mark-as-read `UPDATE`
only ever touches the *other* party's messages — a receipt flip on your own
message only happens via the other person's own request). The response
also returns `serverTime`, and the client anchors its next `since` to that
rather than to the newest message's `createdAt`, avoiding gaps or
duplicate refetches from client/server clock skew.

The frontend poll loop now calls a new `pollActiveThread()` instead of a
full `openConversation()` reload: it patches new messages and read-receipt
updates into the already-rendered thread, and only touches the DOM when
something actually changed. It transparently falls back to a full reload
if there's no valid cursor yet, the active conversation changed since the
cursor was set, or the server reports the gap was too large to fill
incrementally (a tab asleep for hours, say).

Net effect: an idle open thread now costs a near-empty response every poll
instead of re-transferring and re-processing the full visible window every
8 seconds, for every user, all the time.

## Not changed in this round (flagged for later)
- **No caching on the per-request user lookup.** Every authenticated
  request — including all of the above polling — does a full `User` table
  round trip in `requireAuth`. Redis is already wired up in this codebase
  (used for the rate limiter's shared store); a short-TTL cache on that
  lookup would cut real load further, but touches auth-critical code
  (suspended-account checks, session renewal) closely enough that it's
  worth doing as its own careful change rather than bundling here.
- **Conversation search only searches the currently loaded page.** The
  search box in the conversation list filters `this.conversations`
  client-side, which is only whatever page(s) have been loaded (20 at a
  time). A seller with a large inbox can't search threads they haven't
  scrolled to yet. Needs a server-side `q` param on `GET
  /messages/conversations` (the existing trigram-index migrations in this
  repo are the right template for making that fast at scale).
