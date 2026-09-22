-- Single-row platform settings: MTN MoMo / Airtel Money merchant codes shown
-- to sellers when paying their subscription (admin-editable, see
-- routes/admin.js GET/PUT /admin/settings).
CREATE TABLE "PlatformSettings" (
  "id" TEXT NOT NULL DEFAULT 'singleton',
  "mtnMomoCode" TEXT NOT NULL DEFAULT '',
  "mtnMomoName" TEXT NOT NULL DEFAULT 'NextaStore',
  "airtelMoneyCode" TEXT NOT NULL DEFAULT '',
  "airtelMoneyName" TEXT NOT NULL DEFAULT 'NextaStore',
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PlatformSettings_pkey" PRIMARY KEY ("id")
);

INSERT INTO "PlatformSettings" ("id", "updatedAt") VALUES ('singleton', CURRENT_TIMESTAMP);
