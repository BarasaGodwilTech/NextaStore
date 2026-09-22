-- Corrective production migration for the seller subscription rollout.
-- The original subscription migration granted five years to stores that
-- already existed so launch-day visibility would not change unexpectedly.
-- That legacy grant is not a real payment and must not make a seller appear
-- paid/verified. Preserve any store with an actually approved payment.
UPDATE "Store" AS s
SET
  "subscriptionPaidUntil" = NULL,
  "subscriptionStatus" = CASE
    WHEN s."trialEndsAt" > CURRENT_TIMESTAMP THEN 'trial'::"StoreSubscriptionStatus"
    ELSE 'expired'::"StoreSubscriptionStatus"
  END,
  "verified" = FALSE
WHERE NOT EXISTS (
    SELECT 1
    FROM "SubscriptionPayment" AS p
    WHERE p."storeId" = s."id"
      AND p."status" = 'approved'::"SubscriptionPaymentStatus"
  );
