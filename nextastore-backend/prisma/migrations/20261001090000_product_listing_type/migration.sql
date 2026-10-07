-- Listing types: existing rows stay physical products.
ALTER TABLE "Product" ADD COLUMN "listingType" TEXT NOT NULL DEFAULT 'physical';
ALTER TABLE "Product" ADD COLUMN "serviceArea" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Product" ADD COLUMN "serviceDuration" TEXT NOT NULL DEFAULT '';
