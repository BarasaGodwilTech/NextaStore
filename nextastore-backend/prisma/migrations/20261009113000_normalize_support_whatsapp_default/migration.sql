UPDATE "PlatformSettings"
SET "supportWhatsappNumber" = '256761789006'
WHERE "supportWhatsappNumber" = '0761789006';
ALTER TABLE "PlatformSettings"
ALTER COLUMN "supportWhatsappNumber" SET DEFAULT '256761789006';
