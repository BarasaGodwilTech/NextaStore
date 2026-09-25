-- A new store used to start with MTN MoMo and Airtel Money already switched on,
-- so onboarding showed "Payment methods" as done before the seller had chosen
-- anything, and shoppers were told the store accepted methods it never picked.
-- New stores now start with none. Only the column DEFAULT changes: no existing
-- store's payments are touched, so nobody loses a method they rely on.
ALTER TABLE "Store" ALTER COLUMN "payments" SET DEFAULT '{}';
