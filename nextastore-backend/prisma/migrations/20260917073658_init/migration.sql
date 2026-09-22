-- DropIndex
DROP INDEX IF EXISTS "Product_description_trgm_idx";

-- DropIndex
DROP INDEX IF EXISTS "Store_address_trgm_idx";

-- DropIndex
DROP INDEX IF EXISTS "Store_description_trgm_idx";

-- DropIndex
DROP INDEX IF EXISTS "Store_district_trgm_idx";

-- AlterTable
ALTER TABLE "Store" ALTER COLUMN "trialEndsAt" SET DEFAULT (now() + interval '7 days');
