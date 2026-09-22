-- Round 5: fulfillment, trust/reporting, wallet-ready order fields, seller verification.
CREATE TYPE "FulfillmentMethod" AS ENUM ('delivery', 'pickup');
CREATE TYPE "PaymentStatus" AS ENUM ('unpaid', 'paid');
ALTER TABLE "Store" ADD COLUMN "verified" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Order" ADD COLUMN "fulfillmentMethod" "FulfillmentMethod" NOT NULL DEFAULT 'delivery';
ALTER TABLE "Order" ADD COLUMN "paymentMethod" TEXT;
ALTER TABLE "Order" ADD COLUMN "paymentStatus" "PaymentStatus" NOT NULL DEFAULT 'unpaid';
ALTER TABLE "Order" ADD COLUMN "flaggedAt" TIMESTAMP(3);
ALTER TABLE "Order" ADD COLUMN "flagReason" TEXT;
CREATE TABLE "OrderReport" ("id" TEXT NOT NULL,"orderId" TEXT NOT NULL,"reporterId" TEXT NOT NULL,"reason" TEXT NOT NULL,"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,CONSTRAINT "OrderReport_pkey" PRIMARY KEY ("id"));
CREATE UNIQUE INDEX "OrderReport_orderId_reporterId_key" ON "OrderReport"("orderId","reporterId");
CREATE INDEX "OrderReport_orderId_idx" ON "OrderReport"("orderId");
CREATE INDEX "OrderReport_reporterId_idx" ON "OrderReport"("reporterId");
ALTER TABLE "OrderReport" ADD CONSTRAINT "OrderReport_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrderReport" ADD CONSTRAINT "OrderReport_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
