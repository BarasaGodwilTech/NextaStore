-- Crew ID card: a private card photo per member, and the admin's early release.
ALTER TABLE "GrowthPartner" ADD COLUMN "cardPhotoUrl" TEXT,
ADD COLUMN "cardIssuedAt" TIMESTAMP(3),
ADD COLUMN "cardIssuedBy" TEXT;

ALTER TABLE "GrowthUpgrade" ADD COLUMN "cardPhotoUrl" TEXT;
