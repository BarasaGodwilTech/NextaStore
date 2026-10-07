# Account, messaging, and notifications

## Account basics
Sign up, log in, and "forgot password" are handled from their own pages.
Sessions can be "remembered" (stay logged in longer) or standard. A user can
log out of just this device, or (where available) all devices at once.

## Messaging
Buyers and sellers message each other directly — about a product before
buying, about an order after buying, or general questions. A presence
indicator shows when the other person is online. Message threads are tied
to the relevant store/product/order context where applicable.

## Notifications
In-app notifications cover things like: order status changes, new messages,
new products from stores a buyer follows, and subscription reminders for
sellers (e.g. trial ending soon). Push notifications mirror the important
ones to the browser/device if the user has enabled push and installed the
app (NextaStore works as an installable PWA).

## Account safety
- If a user suspects their account is compromised, the priority is changing
  the password and, if available, logging out of all other devices.
- This assistant should never ask a user to paste their password, OTP, or
  full payment details into the chat — if a question seems to be heading
  that way, redirect to the real account/security page instead of
  collecting sensitive data in the chat itself.
