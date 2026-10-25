-- WIP 92: admin-managed support contact for human handoff. Additive only.
ALTER TABLE "PlatformSettings" ADD COLUMN "supportWhatsappNumber" TEXT NOT NULL DEFAULT '0761789006';
ALTER TABLE "PlatformSettings" ADD COLUMN "supportWhatsappEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "PlatformSettings" ADD COLUMN "supportContactLabel" TEXT NOT NULL DEFAULT 'NextaStore support team';
ALTER TABLE "PlatformSettings" ADD COLUMN "supportHoursNote" TEXT NOT NULL DEFAULT '';
