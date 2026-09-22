-- Real per-user store follows. The Store.followers counter remains as the public cached baseline/count; follow actions update it atomically.
CREATE TABLE "StoreFollow" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "storeId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StoreFollow_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "StoreFollow_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "StoreFollow_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "StoreFollow_userId_storeId_key" ON "StoreFollow"("userId", "storeId");
CREATE INDEX "StoreFollow_storeId_idx" ON "StoreFollow"("storeId");
CREATE INDEX "StoreFollow_userId_idx" ON "StoreFollow"("userId");
