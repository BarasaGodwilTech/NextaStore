-- Nexta Circle + Nexta Scouts.
-- Hand-written to match growth.schema.prisma.txt (prisma migrate could not be run in the
-- sandbox, same caveat as earlier migrations: treat "applies cleanly" as unverified until you
-- run `prisma migrate deploy` against a copy of the real database first).
--
-- Purely additive. No existing table is altered; the only change to an existing object is
-- one new value on the NotificationType enum.

-- Needs its own statement; Postgres 12+ allows it inside a migration transaction as long as
-- the new value is not USED in the same transaction (it is not).
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'growth';

CREATE TYPE "GrowthProgram" AS ENUM ('circle', 'scout');
CREATE TYPE "GrowthPartnerStatus" AS ENUM ('applied', 'active', 'frozen', 'rejected', 'retired');
CREATE TYPE "GrowthReferralStage" AS ENUM ('lead', 'signed_up', 'store_live', 'payment_pending', 'paid', 'lapsed', 'blocked', 'void');
CREATE TYPE "GrowthCommissionType" AS ENUM ('first_payment', 'commitment_kicker', 'live_bonus', 'campaign_boost', 'renewal', 'clawback', 'adjustment');
CREATE TYPE "GrowthCommissionStatus" AS ENUM ('held', 'review', 'available', 'voided');
CREATE TYPE "GrowthWithdrawalStatus" AS ENUM ('requested', 'in_review', 'approved', 'paid', 'rejected', 'cancelled');
CREATE TYPE "GrowthFlagStatus" AS ENUM ('open', 'dismissed', 'confirmed');

CREATE TABLE "GrowthPartner" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "program" "GrowthProgram" NOT NULL,
    "status" "GrowthPartnerStatus" NOT NULL DEFAULT 'active',
    "code" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "phone" TEXT NOT NULL DEFAULT '',
    "rankKey" TEXT NOT NULL DEFAULT 'trailhead',
    "territories" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "kycFileUrl" TEXT,
    "applicationNote" TEXT NOT NULL DEFAULT '',
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "payoutNetwork" TEXT,
    "payoutNumber" TEXT,
    "payoutName" TEXT,
    "payoutNumberChangedAt" TIMESTAMP(3),
    "qualityScore" INTEGER NOT NULL DEFAULT 70,
    "frozenReason" TEXT NOT NULL DEFAULT '',
    "frozenAt" TIMESTAMP(3),
    "signupIpPrefix" TEXT NOT NULL DEFAULT '',
    "usualIpPrefixes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "agreedTermsVersion" TEXT NOT NULL DEFAULT '',
    "agreedTermsAt" TIMESTAMP(3),
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "GrowthPartner_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "GrowthReferral" (
    "id" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "stage" "GrowthReferralStage" NOT NULL DEFAULT 'signed_up',
    "source" TEXT NOT NULL DEFAULT 'link',
    "recruitUserId" TEXT,
    "storeId" TEXT,
    "leadBusiness" TEXT NOT NULL DEFAULT '',
    "leadContactName" TEXT NOT NULL DEFAULT '',
    "leadPhone" TEXT NOT NULL DEFAULT '',
    "leadDistrict" TEXT NOT NULL DEFAULT '',
    "leadNote" TEXT NOT NULL DEFAULT '',
    "leadLockExpiresAt" TIMESTAMP(3),
    "leadLockExtensions" INTEGER NOT NULL DEFAULT 0,
    "signedUpAt" TIMESTAMP(3),
    "storeLiveAt" TIMESTAMP(3),
    "paymentSubmittedAt" TIMESTAMP(3),
    "firstPaymentId" TEXT,
    "paidAt" TIMESTAMP(3),
    "qualifyBy" TIMESTAMP(3),
    "lastAskedAt" TIMESTAMP(3),
    "signupIpPrefix" TEXT NOT NULL DEFAULT '',
    "deviceHash" TEXT NOT NULL DEFAULT '',
    "riskDecision" TEXT NOT NULL DEFAULT 'clear',
    "riskScore" INTEGER NOT NULL DEFAULT 0,
    "riskReasons" JSONB NOT NULL DEFAULT '[]',
    "capturedOffline" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "GrowthReferral_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "GrowthVisit" (
    "id" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "referralId" TEXT NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "photoUrl" TEXT,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "visitedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GrowthVisit_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "GrowthCommission" (
    "id" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "referralId" TEXT,
    "paymentId" TEXT,
    "paymentReviewedBy" TEXT,
    "type" "GrowthCommissionType" NOT NULL,
    "amount" INTEGER NOT NULL,
    "status" "GrowthCommissionStatus" NOT NULL DEFAULT 'held',
    "clearsAt" TIMESTAMP(3),
    "releasedBy" TEXT,
    "releasedAt" TIMESTAMP(3),
    "voidReason" TEXT NOT NULL DEFAULT '',
    "note" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GrowthCommission_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "GrowthWithdrawal" (
    "id" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "network" TEXT NOT NULL,
    "payoutNumber" TEXT NOT NULL,
    "payoutName" TEXT NOT NULL DEFAULT '',
    "status" "GrowthWithdrawalStatus" NOT NULL DEFAULT 'requested',
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dueBy" TIMESTAMP(3) NOT NULL,
    "needsSecondApproval" BOOLEAN NOT NULL DEFAULT false,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "paidBy" TEXT,
    "paidAt" TIMESTAMP(3),
    "payoutReference" TEXT NOT NULL DEFAULT '',
    "feeEstimate" INTEGER NOT NULL DEFAULT 0,
    "feeActual" INTEGER,
    "rejectReason" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "GrowthWithdrawal_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "GrowthFlag" (
    "id" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "referralId" TEXT,
    "code" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'medium',
    "detail" JSONB NOT NULL DEFAULT '{}',
    "status" "GrowthFlagStatus" NOT NULL DEFAULT 'open',
    "resolvedBy" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GrowthFlag_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "GrowthCampaign" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "program" "GrowthProgram",
    "district" TEXT NOT NULL DEFAULT '',
    "boostPercent" INTEGER NOT NULL DEFAULT 0,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GrowthCampaign_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "GrowthSettings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "circleOpen" BOOLEAN NOT NULL DEFAULT false,
    "scoutsOpen" BOOLEAN NOT NULL DEFAULT false,
    "extraHolidays" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "termsVersion" TEXT NOT NULL DEFAULT '2026-10-draft',
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "GrowthSettings_pkey" PRIMARY KEY ("id")
);

-- Uniques
CREATE UNIQUE INDEX "GrowthPartner_userId_key" ON "GrowthPartner"("userId");
CREATE UNIQUE INDEX "GrowthPartner_code_key" ON "GrowthPartner"("code");
CREATE UNIQUE INDEX "GrowthReferral_recruitUserId_key" ON "GrowthReferral"("recruitUserId");
CREATE UNIQUE INDEX "GrowthReferral_storeId_key" ON "GrowthReferral"("storeId");
CREATE UNIQUE INDEX "GrowthCommission_paymentId_partnerId_type_key" ON "GrowthCommission"("paymentId", "partnerId", "type");

-- Lookups
CREATE INDEX "GrowthPartner_program_status_idx" ON "GrowthPartner"("program", "status");
CREATE INDEX "GrowthPartner_payoutNumber_idx" ON "GrowthPartner"("payoutNumber");
CREATE INDEX "GrowthReferral_partnerId_stage_idx" ON "GrowthReferral"("partnerId", "stage");
CREATE INDEX "GrowthReferral_partnerId_createdAt_idx" ON "GrowthReferral"("partnerId", "createdAt");
CREATE INDEX "GrowthReferral_leadPhone_idx" ON "GrowthReferral"("leadPhone");
CREATE INDEX "GrowthReferral_stage_paymentSubmittedAt_idx" ON "GrowthReferral"("stage", "paymentSubmittedAt");
CREATE INDEX "GrowthVisit_referralId_idx" ON "GrowthVisit"("referralId");
CREATE INDEX "GrowthVisit_partnerId_visitedAt_idx" ON "GrowthVisit"("partnerId", "visitedAt");
CREATE INDEX "GrowthCommission_partnerId_status_idx" ON "GrowthCommission"("partnerId", "status");
CREATE INDEX "GrowthCommission_status_clearsAt_idx" ON "GrowthCommission"("status", "clearsAt");
CREATE INDEX "GrowthCommission_referralId_idx" ON "GrowthCommission"("referralId");
CREATE INDEX "GrowthWithdrawal_partnerId_status_idx" ON "GrowthWithdrawal"("partnerId", "status");
CREATE INDEX "GrowthWithdrawal_status_dueBy_idx" ON "GrowthWithdrawal"("status", "dueBy");
CREATE INDEX "GrowthWithdrawal_partnerId_requestedAt_idx" ON "GrowthWithdrawal"("partnerId", "requestedAt");
CREATE INDEX "GrowthFlag_partnerId_status_idx" ON "GrowthFlag"("partnerId", "status");
CREATE INDEX "GrowthFlag_status_createdAt_idx" ON "GrowthFlag"("status", "createdAt");
CREATE INDEX "GrowthCampaign_isActive_startsAt_endsAt_idx" ON "GrowthCampaign"("isActive", "startsAt", "endsAt");

-- Foreign keys between growth tables only
ALTER TABLE "GrowthReferral" ADD CONSTRAINT "GrowthReferral_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "GrowthPartner"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GrowthVisit" ADD CONSTRAINT "GrowthVisit_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "GrowthPartner"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GrowthVisit" ADD CONSTRAINT "GrowthVisit_referralId_fkey" FOREIGN KEY ("referralId") REFERENCES "GrowthReferral"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GrowthCommission" ADD CONSTRAINT "GrowthCommission_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "GrowthPartner"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GrowthCommission" ADD CONSTRAINT "GrowthCommission_referralId_fkey" FOREIGN KEY ("referralId") REFERENCES "GrowthReferral"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "GrowthWithdrawal" ADD CONSTRAINT "GrowthWithdrawal_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "GrowthPartner"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GrowthFlag" ADD CONSTRAINT "GrowthFlag_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "GrowthPartner"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Things Prisma cannot express, so they live only here:
-- 1) A prospect phone number can be an ACTIVE lead for only one Scout at a time (the lead lock).
--    The service moves expired leads to 'lapsed' so this index frees the number again.
CREATE UNIQUE INDEX "GrowthReferral_active_lead_phone_key" ON "GrowthReferral"("leadPhone") WHERE "stage" = 'lead' AND "leadPhone" <> '';
-- 2) One open withdrawal per partner, enforced by the database so two quick taps cannot both pass.
CREATE UNIQUE INDEX "GrowthWithdrawal_one_open_per_partner_key" ON "GrowthWithdrawal"("partnerId") WHERE "status" IN ('requested', 'in_review', 'approved');
-- 3) Money sanity: withdrawals are positive; commission rows are never zero.
ALTER TABLE "GrowthWithdrawal" ADD CONSTRAINT "GrowthWithdrawal_amount_positive" CHECK ("amount" > 0);
ALTER TABLE "GrowthCommission" ADD CONSTRAINT "GrowthCommission_amount_nonzero" CHECK ("amount" <> 0);
-- Prisma will report the partial index as drift on `migrate dev`; that is expected, keep it.
