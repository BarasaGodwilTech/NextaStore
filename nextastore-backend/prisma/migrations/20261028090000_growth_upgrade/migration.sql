-- Circle -> Crew upgrade.
-- Hand-written (prisma migrate cannot run where this was written): run `prisma migrate deploy` on a COPY of the real database first.
--
-- What changes, and why it is safe for money:
--  * GrowthReferral.program: the program the partner was in when that person signed up. Backfilled below from the partner's
--    CURRENT program, which is exactly right today because nobody has ever changed program yet. From now on it is set once at
--    sign-up and decides which rules pay that referral, so an upgrade can never re-price what was already earned or promised.
--  * GrowthPartner.previousCodes / upgradedAt / upgradedFrom: an approved upgrade issues a new Crew code and keeps the old one
--    here, so every link or code already shared keeps working.
--  * GrowthUpgrade: one row per request (applied / approved / declined / withdrawn). Only ONE open request per partner (partial unique index).

CREATE TYPE "GrowthUpgradeStatus" AS ENUM ('applied', 'approved', 'declined', 'withdrawn');

ALTER TABLE "GrowthPartner"
    ADD COLUMN "previousCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    ADD COLUMN "upgradedAt" TIMESTAMP(3),
    ADD COLUMN "upgradedFrom" "GrowthProgram";

CREATE INDEX "GrowthPartner_previousCodes_idx" ON "GrowthPartner" USING GIN ("previousCodes");

ALTER TABLE "GrowthReferral" ADD COLUMN "program" "GrowthProgram";
UPDATE "GrowthReferral" r SET "program" = p."program" FROM "GrowthPartner" p WHERE r."partnerId" = p."id";

CREATE TABLE "GrowthUpgrade" (
    "id" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "fromProgram" "GrowthProgram" NOT NULL,
    "toProgram" "GrowthProgram" NOT NULL,
    "status" "GrowthUpgradeStatus" NOT NULL DEFAULT 'applied',
    "phone" TEXT NOT NULL DEFAULT '',
    "territories" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "note" TEXT NOT NULL DEFAULT '',
    "kycFileUrl" TEXT,
    "agreedTermsVersion" TEXT NOT NULL DEFAULT '',
    "signupIpPrefix" TEXT NOT NULL DEFAULT '',
    "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT NOT NULL DEFAULT '',
    "oldCode" TEXT NOT NULL DEFAULT '',
    "newCode" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "GrowthUpgrade_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "GrowthUpgrade_partnerId_status_idx" ON "GrowthUpgrade"("partnerId", "status");
CREATE INDEX "GrowthUpgrade_status_appliedAt_idx" ON "GrowthUpgrade"("status", "appliedAt");
-- The database itself refuses a second open request for the same partner (a double tap, two tabs).
CREATE UNIQUE INDEX "GrowthUpgrade_one_open_per_partner" ON "GrowthUpgrade"("partnerId") WHERE "status" = 'applied';

ALTER TABLE "GrowthUpgrade" ADD CONSTRAINT "GrowthUpgrade_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "GrowthPartner"("id") ON DELETE CASCADE ON UPDATE CASCADE;
