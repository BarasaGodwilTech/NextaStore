-- Per-user saved/"liked" products, so a buyer's favorites persist and can be
-- listed later (see GET/POST/DELETE /favorites). Mirrors StoreFollow's shape.
CREATE TABLE "ProductFavorite" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProductFavorite_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProductFavorite_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ProductFavorite_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ProductFavorite_userId_productId_key" ON "ProductFavorite"("userId", "productId");
CREATE INDEX "ProductFavorite_productId_idx" ON "ProductFavorite"("productId");
CREATE INDEX "ProductFavorite_userId_idx" ON "ProductFavorite"("userId");
