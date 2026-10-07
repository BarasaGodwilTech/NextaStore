# Payment methods

## How payment methods work on NextaStore
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

## Mobile money
The two mobile-money options built into the platform today are **MTN MoMo**
and **Airtel Money**. A store that accepts one or both shows a phone
number/merchant code for that method at checkout and (for subscription
payments) on the seller's own subscription page.

## Card payments
Card is represented as a payment option a store can opt into, alongside the
mobile-money options. If a buyer doesn't see card as an option on a
particular store, that store hasn't enabled it.

## If a payment seems stuck or a method is missing
- A missing method almost always means that store hasn't turned it on —
  suggest the buyer ask the seller via Messages, or try another accepted
  method.
- For anything that looks like a genuine payment failure or a charge that
  didn't go through, don't guess at a fix — recommend contacting NextaStore
  support with the order/reference number, since payment issues need a
  human to check the actual transaction record.
