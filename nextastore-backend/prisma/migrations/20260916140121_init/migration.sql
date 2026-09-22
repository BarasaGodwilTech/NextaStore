-- AlterTable
ALTER TABLE "Store" ALTER COLUMN "trialEndsAt" SET DEFAULT (now() + interval '7 days');
