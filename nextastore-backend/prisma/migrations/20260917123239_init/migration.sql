-- DropIndex
DROP INDEX "Product_description_trgm_idx";

-- DropIndex
DROP INDEX "Store_address_trgm_idx";

-- DropIndex
DROP INDEX "Store_description_trgm_idx";

-- DropIndex
DROP INDEX "Store_district_trgm_idx";

-- AlterTable
ALTER TABLE "Store" ALTER COLUMN "trialEndsAt" SET DEFAULT (now() + interval '7 days');
