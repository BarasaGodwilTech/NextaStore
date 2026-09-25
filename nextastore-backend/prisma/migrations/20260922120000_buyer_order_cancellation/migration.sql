-- Buyer self-service order cancellation (short grace period after placing
-- an order, with a required reason). Separate columns from the existing
-- `flaggedAt`/`flagReason` report pair, and separate in meaning from a
-- seller moving an order to 'cancelled' via PUT /:id/status: only a row
-- with `cancelInitiator = 'buyer'` counts toward the anti-abuse cancel
-- count in POST /orders/:id/cancel, so a seller-side cancellation (e.g. out
-- of stock) never eats into a buyer's own cancellation allowance.
-- Every existing order gets NULL across the board, which reads correctly
-- as "not buyer-cancelled" regardless of its current status.
ALTER TABLE "Order" ADD COLUMN "cancelledAt" TIMESTAMP(3);
ALTER TABLE "Order" ADD COLUMN "cancelReason" TEXT;
ALTER TABLE "Order" ADD COLUMN "cancelDetails" TEXT;
ALTER TABLE "Order" ADD COLUMN "cancelInitiator" TEXT;

-- Powers the anti-abuse rolling-window count: "how many times has this
-- buyer cancelled in the last N days" filters on exactly these two columns.
CREATE INDEX "Order_buyerId_cancelInitiator_cancelledAt_idx" ON "Order"("buyerId", "cancelInitiator", "cancelledAt");
