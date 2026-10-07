# Buying on NextaStore

## Finding products
Buyers can browse the Marketplace page, search, and filter by category. Each
store also has its own store page listing only that seller's products.

## Product detail page
Shows price, description, images, how many have sold, and stock status. From
here a buyer can add the item to their cart, favorite it for later, follow
the store, or message the seller directly with questions before buying.

## Cart and checkout
Items sit in the cart until checkout. At checkout the buyer picks a delivery
district/address and a payment method. Only payment methods that are (a)
currently enabled platform-wide by an admin, and (b) accepted by that
specific store, are shown as options — see `03-payments.md` for how that
works. If a buyer doesn't see a payment method they expected, it likely
means that particular store hasn't turned it on, not that it's broken.

## Placing and tracking an order
After checkout, the order appears on the buyer's Orders page with a status
that updates as the seller processes it. Buyers get a notification (and push
notification, if enabled) on status changes. The exact status names and what
each one is shown as are in the generated platform facts file.

## Cancelling an order (buyer side)
A buyer can cancel their own order from the Orders page, but only for a short
time after placing it, only while the seller has not finished it, with a short
reason, and only a limited number of times. The exact window and limit are in
the generated platform facts file; quote those, never guess. Once the window has
passed, or the limit is used, contact the seller directly through Messages and
ask them to cancel.

## Favorites and Following
- **Favorites** save individual products for later — visible on the
  Favorites page.
- **Following** subscribes a buyer to a store — followers get notified when
  that store adds a new product.

## Safety while buying
See `05-orders-and-safety.md`. In short: keep payment and communication on
the platform where there's a record of it, and be cautious of any seller
who pushes hard for an off-platform payment before shipping anything.
