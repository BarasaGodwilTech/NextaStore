-- Round 6: administrator role and report review state
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'admin';
ALTER TABLE "OrderReport" ADD COLUMN "reviewedAt" TIMESTAMP(3), ADD COLUMN "reviewedBy" TEXT;
CREATE INDEX "OrderReport_reviewedAt_idx" ON "OrderReport"("reviewedAt");
