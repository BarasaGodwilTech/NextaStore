-- "Scouts" became "Crew" (NextaStore Crew). This brings the database in line with the name.
--
-- 1) The program enum value. RENAME VALUE rewrites nothing on disk: every existing row that
--    held 'scout' (GrowthPartner.program, GrowthPartner.upgradedFrom, GrowthUpgrade.fromProgram /
--    toProgram, GrowthReferral.program, GrowthCampaign.program) now reads 'crew'. Partial indexes
--    and constraints that mention the value follow it automatically.
-- 2) The settings column that says whether Crew applications are open.
-- 3) Admin audit entries written under the old names, so the audit feed and its filter still
--    find them.
-- 4) Partner codes issued as SCOUT-XXXXX become CREW-XXXXX (the code is the only place a code is
--    stored; everything else links by partner id). Nothing in the app reads SCOUT- codes any more.
--
-- Safe to run once on a live database. Take a backup first, as with any migration.

ALTER TYPE "GrowthProgram" RENAME VALUE 'scout' TO 'crew';

ALTER TABLE "GrowthSettings" RENAME COLUMN "scoutsOpen" TO "crewOpen";

UPDATE "AdminAuditLog"
   SET "action" = REPLACE("action", 'growth.scout_', 'growth.crew_')
 WHERE "action" LIKE 'growth.scout\_%';

UPDATE "GrowthPartner"
   SET "code" = 'CREW-' || SUBSTRING("code" FROM 7)
 WHERE "code" LIKE 'SCOUT-%';
