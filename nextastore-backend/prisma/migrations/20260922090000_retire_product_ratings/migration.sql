-- Product ratings/reviews are retired for the same reason Store.rating was
-- retired in migration 20260915180000_seller_badge_commitment: NextaStore
-- connects a buyer and a seller, who then arrange fulfillment directly
-- between themselves. The platform never confirms an order was actually
-- fulfilled, so a star rating or review count is not a verifiable trust
-- signal here -- it's dropped rather than kept as a vanity number.

DROP TABLE IF EXISTS "Review";

ALTER TABLE "Product"
  DROP COLUMN IF EXISTS "rating",
  DROP COLUMN IF EXISTS "reviews";
