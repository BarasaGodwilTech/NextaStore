-- CreateIndex
CREATE INDEX "Product_storeId_createdAt_idx" ON "Product"("storeId", "createdAt");

-- CreateIndex
CREATE INDEX "Product_storeId_sold_idx" ON "Product"("storeId", "sold");

-- CreateIndex
CREATE INDEX "Product_storeId_price_idx" ON "Product"("storeId", "price");

-- CreateIndex
CREATE INDEX "Product_sold_idx" ON "Product"("sold");

-- CreateIndex
CREATE INDEX "Store_createdAt_idx" ON "Store"("createdAt");
