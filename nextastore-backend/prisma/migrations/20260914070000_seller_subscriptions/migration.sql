-- Seller subscriptions: 7-day free trial, then a paid "verified" badge.
-- Payment is submitted by the seller (mobile money reference code) and
-- confirmed by an admin — see routes/subscription.js and routes/admin.js.
CREATE TYPE "StoreSubscriptionStatus" AS ENUM ('trial', 'active', 'expired');
CREATE TYPE "SubscriptionPaymentStatus" AS ENUM ('pending', 'approved', 'rejected');
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'subscription';

ALTER TABLE "Store"
  ADD COLUMN "subscriptionStatus" "StoreSubscriptionStatus" NOT NULL DEFAULT 'trial',
  ADD COLUMN "trialEndsAt" TIMESTAMP(3) NOT NULL DEFAULT (now() + interval '7 days'),
  ADD COLUMN "subscriptionPaidUntil" TIMESTAMP(3);

-- Grandfather every store that already existed before this feature shipped
-- so launch day doesn't suddenly hide anyone already live on the
-- marketplace behind a trial wall they never opted into.
UPDATE "Store" SET "subscriptionStatus" = 'active', "subscriptionPaidUntil" = now() + interval '5 years';

CREATE TABLE "SubscriptionPayment" (
  "id" TEXT NOT NULL,
  "storeId" TEXT NOT NULL,
  "amount" DECIMAL(12,2) NOT NULL,
  "method" TEXT NOT NULL,
  "reference" TEXT NOT NULL,
  "periodMonths" INTEGER NOT NULL DEFAULT 1,
  "status" "SubscriptionPaymentStatus" NOT NULL DEFAULT 'pending',
  "note" TEXT NOT NULL DEFAULT '',
  "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reviewedAt" TIMESTAMP(3),
  "reviewedBy" TEXT,
  CONSTRAINT "SubscriptionPayment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SubscriptionPayment_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "SubscriptionPayment_storeId_idx" ON "SubscriptionPayment"("storeId");
CREATE INDEX "SubscriptionPayment_status_idx" ON "SubscriptionPayment"("status");
