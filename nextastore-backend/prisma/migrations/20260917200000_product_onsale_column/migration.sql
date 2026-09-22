-- Adds the denormalized onSale flag (see schema.prisma comment on
-- Product.onSale for why this exists) and backfills it for every existing
-- row from the current price/originalPrice, so nothing already in the
-- database silently starts reporting onSale = false until its next edit.

ALTER TABLE "Product" ADD COLUMN "onSale" BOOLEAN NOT NULL DEFAULT false;

UPDATE "Product"
SET "onSale" = ("originalPrice" IS NOT NULL AND "originalPrice" > "price");

CREATE INDEX "Product_onSale_sold_idx" ON "Product"("onSale", "sold");
