-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('buyer', 'seller');

-- AlterTable
-- Every existing user defaults to "buyer" first, then gets backfilled below
-- for anyone who already owns a store — otherwise this migration would
-- silently lock every existing seller out of their own seller-only routes
-- the moment requireSeller() ships.
ALTER TABLE "User" ADD COLUMN "role" "UserRole" NOT NULL DEFAULT 'buyer';

-- Backfill: any user who already owns a (non-deleted or deleted) store was
-- clearly acting as a seller before this column existed.
UPDATE "User"
SET "role" = 'seller'
WHERE "id" IN (SELECT "ownerId" FROM "Store" WHERE "ownerId" IS NOT NULL);
