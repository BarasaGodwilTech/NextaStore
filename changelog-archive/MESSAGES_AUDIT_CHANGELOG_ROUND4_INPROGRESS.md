# Messages flow — round 4 (in progress): failed sends + a stale-data race

Files touched so far: `js/messages.js`, `css/messages.css`. This round is
NOT finished — see the "Still open" list at the bottom. Drop these two
files in at the same paths, replacing the existing ones.

## 1. Fixed: a failed send used to just disappear
`sendMessagePayload` showed an optimistic "sending…" bubble immediately,
then — on failure — rolled it back and discarded it completely. Whatever
was typed, or whichever product/location had been picked, was gone, with
no way to get it back short of redoing the whole thing.

Restructured into three pieces:
- `sendMessagePayload(...)` — builds the optimistic bubble (now also
  keeping its original `body`/`attachment`/`optimisticProduct` on the
  message object itself, under `_payload`, so it can be resent later
  without asking the sender to redo anything).
- `dispatchOptimisticMessage(optimisticMessage)` — does the actual network
  call. On success, unchanged. On failure, the bubble is flipped to
  `failed: true` **in place** instead of being torn out.
- `retryMessage(tempId)` / `discardMessage(tempId)` — new. A failed bubble
  now shows a "Message failed to send" row with **Resend** and **Delete**
  buttons (see `buildMessagesHtml`'s new `failedActions` block, and the
  `.message-failed-*` CSS). Resend re-runs the exact same send through
  `dispatchOptimisticMessage`; Delete just removes that one bubble.

## 2. Fixed: a real pre-existing rendering bug in read receipts
While touching the receipt markup for the new failed state, found that
`.message-receipt::before { content: '\2713' }` was never overridden for
the `.is-pending` (clock icon) or now `.is-failed` (warning icon) states —
so the checkmark glyph and the icon were both rendering on top of each
other for any sending/failed message the whole time. Added the missing
override.

## 3. De-duplicated: the same thread-repaint logic, five times over
`container.innerHTML = (load-older button…) + buildMessagesHtml(...)` plus
re-wiring its listener and the location-card map renders was copy-pasted
across five separate call sites (initial render, poll, load-older,
send, and the old failure-rollback). That's the kind of duplication where
a fix to one copy — like the failed-message styling just added — is easy
to forget in the other four. Extracted into one `paintThreadMessages(container)`
helper; every call site now calls that plus whatever custom scroll
handling it already had.

## 4. Fixed: a real (if narrow) "thread appears to change on its own" race
Went looking specifically for what could cause a conversation to visibly
open, close, or revert without a corresponding tap, since that's what was
reported. The obvious paths were already correctly guarded — the 8s
background poll only ever touches the conversation that's already open,
never a different one, and popstate/deep-link opens are gated on genuine
navigation.

Found a subtler real gap in `openConversation`'s staleness check: it
compared only the conversation's `id` to decide whether a resolved request
was still relevant. That misses leaving conversation A and then
**reopening the same conversation A again** before an earlier, slower
request for A (typically the background poll's own fallback reload) has
finished — both requests have `id === 'A'`, so the id check alone can't
tell the stale one from the fresh one. If the stale one landed second, it
could silently overwrite what the fresh, newer open had just rendered:
read receipts reverting, a just-sent message flickering out of view, that
kind of thing — which reads exactly like "something changed with no tap
behind it."

Fixed with a monotonically increasing request token: every call to
`openConversation` gets its own token, and only the call whose token still
matches when its request resolves is allowed to render. Strictly stronger
than the old id-only check, which is kept alongside it as a second,
belt-and-suspenders guard.

## Still open — not done in this round
These were all raised in the same request and are NOT yet addressed;
flagging clearly rather than claiming more than what's actually in this
zip:
- **Notifications still merge in raw messages.** Confirmed the actual
  cause: `loadNotificationPreview()` in `js/main.js` fetches `/notifications`
  *and* a second, separate feed from `/messages/conversations`, then
  merges both into the bell dropdown — even though the backend already
  creates a proper "New message from X" notification (linking to the right
  conversation) for every message sent. The second feed is redundant and
  needs to be removed so the dropdown shows only real notifications. Not
  yet edited.
- **Mobile vs. desktop behavioral differentiation** — not started.
- **"Load a bit faster"** — not started as its own pass (round 2's
  incremental-polling work helps ongoing load, but initial-load speed
  hasn't been specifically profiled/addressed).
- **Full error-handling sweep** — this round focused specifically on the
  send/retry path and the auto-open investigation; the rest of the file
  hasn't had a dedicated pass yet.
- One known limitation carried over from the failed-send fix: a failed
  bubble that's still sitting unresolved (not retried or deleted) will be
  silently dropped if the thread ever does a full reload from the server
  (switching away and back, or the incremental-poll's own "gap too big"
  fallback) — same as an unsent draft not surviving a hard refresh in most
  chat apps, but worth knowing about.
