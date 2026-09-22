-- Seller trust is now badge-based. A Verified Seller badge requires a
-- confirmed paid commitment of at least 6 months. Store.rating was a weak
-- seller-trust signal because NextaStore does not control whether an order
-- is acknowledged/completed, so it is retired from the Store model.

ALTER TABLE "Store"
  ADD COLUMN "badgeCommitmentMonths" INTEGER NOT NULL DEFAULT 0;

-- Reconstruct the current commitment from the latest approved payment.
-- This preserves real paid commitments while ignoring the old launch grant
-- and any pending/rejected submissions.
UPDATE "Store" AS s
SET "badgeCommitmentMonths" = COALESCE((
  SELECT p."periodMonths"
  FROM "SubscriptionPayment" AS p
  WHERE p."storeId" = s."id"
    AND p."status" = 'approved'::"SubscriptionPaymentStatus"
  ORDER BY p."reviewedAt" DESC NULLS LAST, p."submittedAt" DESC
  LIMIT 1
), 0);

UPDATE "Store"
SET "verified" = (
  "badgeCommitmentMonths" >= 6
  AND "subscriptionPaidUntil" IS NOT NULL
  AND "subscriptionPaidUntil" > CURRENT_TIMESTAMP
);

DROP INDEX IF EXISTS "Store_rating_idx";
ALTER TABLE "Store" DROP COLUMN IF EXISTS "rating";
