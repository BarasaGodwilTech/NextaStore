# Two-tier notifications: frontend verification pass (on top of presence part 2c)

The backend half (`readAt` / `acknowledgedAt`, `PUT /notifications/acknowledge`,
`/:id/read`, `/read-all`, migration `20260919210000_notification_acknowledged_at`)
already existed. This pass added the first real-browser test of the bell and
fixed what it found.

## New: `scripts/notifications-browser-test.js` (`npm run test:notifications-browser`)
Runs the REAL bell from `js/main.js` on the REAL `messages.html` against a small
STATEFUL fake of `routes/notifications.js` on localhost:4000. 21 checks:
badge = unacknowledged count; bell tap clears only the badge; items stay
unread; server stamps `acknowledgedAt` only; state survives a reload; tapping
one item reads just that item; a new arrival brings the badge back as 1 without
recounting old unread items; "Mark all as read" clears every item; 44x44 touch
targets on a 390px viewport; no page errors. 4 failed before the fixes below,
plus 1 more (bell width) once the touch-target check was added.

## Fixed (`js/main.js`, `css/main.css`)
1. **Slow list delayed the badge.** The bell awaited the list request before
   clearing the badge (the comment said "immediately"). On a slow connection
   the badge sat there for seconds. Now it clears on tap, the acknowledge is
   sent in parallel with the list load, and the badge is confirmed against
   the server once the acknowledge lands (so a failed acknowledge doesn't
   leave a false 0 for long, and a poll in flight can't repaint a stale count).
2. **Link-less notifications could never be marked read by tapping.** They
   rendered as a plain `div` with no handler; only "Mark all" could clear
   them, contradicting "clears only when that notification is tapped".
   Now a `div` carries `data-notification-id`, `role="button"`, `tabindex="0"`,
   and Enter/Space work.
3. **Batch action label:** "Mark notifications read" -> "Mark all as read".
4. **Touch targets:** the batch button had no padding (about 15px tall); now
   44px minimum. The bell was 42x42; now 44x44.

## Not done / worth knowing
- The dropdown shows the 10 newest (server returns 30). Unread items beyond
  the tenth are invisible except via "Mark all as read". There is no full
  notifications page; the spec says "dropdown/page", so one is probably worth
  adding.
- The bell list does not refresh while it is open; a notification arriving
  then moves the badge (next 20s poll) but not the list.
- The fake API mirrors `src/routes/notifications.js` by reading it, not by
  running it; `test:integration` still needs npm install + Postgres.
- `main.js` / `main.css` changed after the v8 service worker bump: fine while
  v8 is unreleased, otherwise bump to v9.
