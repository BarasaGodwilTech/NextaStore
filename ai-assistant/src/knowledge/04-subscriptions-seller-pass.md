# Seller Pass (seller subscription)

## What it is
"Seller Pass" is what keeps a store active on the platform. Every new store
starts with a **free trial** period. The seller's subscription page shows
how many trial days are left. The price and the trial length are in the
generated platform facts file.

## Paying for coverage
Once the trial ends (or a seller wants to pay ahead of time), coverage is
bought in month-blocks, paid via mobile money (MTN MoMo or Airtel Money —
see `03-payments.md`). The flow is:
1. Seller picks how many months of coverage to buy (the month-blocks on offer
   are in the generated platform facts file).
2. Seller sends the mobile money payment to the code/number shown, then
   submits the payment reference on the subscription page.
3. An admin reviews and approves the payment.
4. Once approved, the store's paid coverage is extended by that many months.

Payments show as **Pending** until an admin approves them, then flip to
**Approved** (or **Not confirmed** if rejected). This review step means
there can be a delay between sending money and the store showing as paid —
that's expected, not a bug.

## What happens if coverage lapses
If a store's paid coverage (or trial) runs out before it's renewed, the
subscription status shows as ended and the seller is prompted to renew.
Renewing before then keeps the store active without interruption.

## Seller badge
Badge tiers are earned from continuous paid coverage: payments made while the
store is still covered add up, and a lapse starts the count again. The tiers
and the months each needs are in the generated platform facts file (see also
`02-selling-and-stores.md`).

## What this assistant should not do
Never tell a seller their payment has been approved, or guess a days-left
number — that status is live data on their subscription page, not something
in this knowledge base. Point them to the subscription page, or to support
if the page itself looks wrong.
