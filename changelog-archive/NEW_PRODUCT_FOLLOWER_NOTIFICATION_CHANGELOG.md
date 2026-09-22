# Follower notifications on new product

When a store adds a new product, everyone following that store now gets a
notification (in the bell) and a push (if they've enabled it) — no action
needed from the seller beyond adding the product as usual.

## What's in this package

- **`src/helpers.js` — `notifyStoreFollowersOfNewProduct()`:**
  - Looks up the store's followers (`StoreFollow`) and writes one
    `Notification` row per follower in a single `createMany`, not a loop of
    individual inserts — a store with a few thousand followers must not turn
    "add a product" into a few thousand sequential round trips.
  - Fans push out to every follower afterward via the existing
    `sendPushToUser` (from the Web Push packages), one call per follower
    since that function's own device fan-out is already per-user.
  - **Excludes the store's own owner**, even if `StoreFollow` would
    technically let someone follow their own store — "your store just added
    a product" isn't news to the person who added it.
  - Skips doing anything at all when there are no followers (the common
    case for a brand-new store).
  - Title: `"<Store name> added a new product"`. Body: the product name,
    truncated at 120 characters (same convention `notifyNewMessage` uses for
    a message preview — `productSchema` has no max length on `name`, so this
    is what keeps a long title from blowing out the bell's layout). Link:
    `product-detail.html?id=<id>&store=<slug>`, the same pattern already
    used everywhere else in the app that links to a product.
  - Same never-throws contract as the rest of `helpers.js`'s notification
    functions.
- **`src/routes/products.js`:** calls the helper right after
  `POST /api/products` creates the product, **deliberately not awaited** —
  same reasoning as `notifyNewMessage` in `routes/messages.js` — so a store
  with a large following never adds latency to the seller's own "product
  created" response.
- **Schema:** added `new_product` to the `NotificationType` enum, plus a
  migration (`ALTER TYPE ... ADD VALUE IF NOT EXISTS`) — same pattern as the
  existing migration that added `subscription`.
- **`js/main.js`:** the bell now shows a distinct icon (`fa-tags`) for
  `new_product` instead of falling back to the generic bell icon.

## Verification

| Suite | Result |
| --- | --- |
| `qa:static` (12 new checks) | 90/90, was 78/78 |
| `test:seo` | 10/10 |
| `test:push` (all four push sub-suites, unchanged this round) | 48/48 + 27/27 + 32/32 + 30/30 |
| **New:** `notify-followers-test.js`, real `helpers.js` + real `routes/products.js` with Prisma/Express/web-push/config stubbed (`npm run test:new-product-notify`) | 15/15 |
| Migration-history replay guard (all 6 trigram indexes survive the full chain, net of the new migration) | still passing |

I mutation-tested the new code two ways and both were caught:
- Removing the owner-exclusion filter — caught immediately by the dedicated
  check.
- Accidentally `await`-ing the fire-and-forget call in `products.js` — this
  one is worth calling out. It didn't just fail a check; my first version of
  that test *hung the whole process*, and because nothing else was keeping
  Node's event loop alive, the process quietly exited with **zero output
  and exit code 0** — indistinguishable from "nothing ran" rather than a
  clear failure. I hardened the test by racing the request against a 300ms
  timeout, so this same regression now produces a normal, loud `FAIL`
  instead of a silent non-result. Both are included in the 15/15 above.

## Not verified

- No real Postgres — the migration's SQL is checked for shape (valid plain
  `ALTER TYPE ... ADD VALUE`, matching the working precedent) but has not
  been run against a real database.
- No real push delivery — same limitation as every push package so far;
  `sendPushToUser` itself is already covered end-to-end by
  `push-backend-test.js`, and this package's own suite confirms it's called
  correctly for every follower, but nothing here confirms an actual
  notification lands on an actual device.
- Multiple products added in quick succession by the same store: each
  triggers its own independent fan-out. Not a problem in itself, but a
  seller bulk-adding 50 products would currently generate 50 separate
  notifications per follower rather than one batched one. Worth a follow-up
  if that turns out to matter in practice.

Say the word for the next feature — real-time presence, the two-tier
notification read states, dynamic payment methods, or the admin RBAC
overhaul.
