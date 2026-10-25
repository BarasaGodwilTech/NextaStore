# Payment methods

## How payment methods work on NextaStore
aliases: what ways can i pay | can i pay with mobile money | do you accept cards | payment options on the site | how do payments work | where do i see payment options
Payment methods are managed dynamically by platform admins, not hardcoded
into the app. This means:
- Admins turn payment methods on/off platform-wide from the admin console.
- Each individual store separately chooses which of the platform-enabled
  methods it wants to accept (a store can accept a subset).
- What a buyer actually sees at checkout is the overlap: methods that are
  both platform-enabled AND accepted by that specific store.

Because this is admin-configurable, the exact list of available methods can
change over time without any code changes. **Do not assume a fixed, final
list of payment methods when answering — if you're not certain what's
currently enabled, say that the available options are shown at checkout /
in the store's payment settings, rather than naming methods that may no
longer be accurate.**

## Paying for an order as a buyer at checkout
aliases: how do i pay for what i buy | can i pay when it arrives | pay cash on pickup | does nextastore take my money | do i pay on the site | what is intended payment method | when do i pay | collect my order myself | pickup instead of delivery | go to the store to get my item
NextaStore does not take or process payment from buyers. Checkout only sends
each seller an order request, and the buyer and the seller agree on how and
when the money is paid. For each store in the cart the buyer chooses:
- **Delivery** (a delivery address is needed) or **Pick up / visit the store**
  (no address needed).
- An **Intended payment method** from the list that store accepts, such as
  Cash, MTN MoMo, Airtel Money or Card, or **I'll agree with the seller**. This
  is only a note to the seller: no money moves at this step.

The buyer also gives a name and a phone number and ticks a box to confirm they
understand NextaStore does not process payment. Placing the order sends a
separate order request to each seller, and it appears on the buyer's Orders
page with the payment method the buyer chose. Next the seller confirms the
order, and the buyer arranges payment and delivery or pickup with the seller,
using Messages if needed.

Only methods the store has switched on can be chosen, and a new store accepts
none until its seller turns some on, so a store may offer only "I'll agree with
the seller". Whether a buyer pays in cash when the item is handed over, or
sends mobile money first, is agreed with the seller. NextaStore does not take
or check that payment.

## Mobile money
aliases: airtel money payments | pay with phone money | mobile money numbers | which mobile money is supported
The two mobile-money options built into the platform today are **MTN MoMo**
and **Airtel Money**. For a buyer, these are methods a store can accept for its
orders (see paying for an order as a buyer). NextaStore's own mobile-money
number is shown only on a seller's subscription page, for the seller's coverage.

## Card payments
aliases: pay with a bank card | visa or mastercard | why no card option | can i use my card | card not available at checkout
Card is represented as a payment option a store can opt into, alongside the
mobile-money options. If a buyer doesn't see card as an option on a
particular store, that store hasn't enabled it.

## If a payment seems stuck or a method is missing
aliases: my payment is not working | a payment method is missing at checkout | money was deducted but nothing happened | payment failed | payment problem who do i ask | payment not going through
- A missing method almost always means that store hasn't turned it on —
  suggest the buyer ask the seller via Messages, or try another accepted
  method.
- For anything that looks like a genuine payment failure or a charge that
  didn't go through, don't guess at a fix — recommend contacting NextaStore
  support with the order/reference number, since payment issues need a
  human to check the actual transaction record.
