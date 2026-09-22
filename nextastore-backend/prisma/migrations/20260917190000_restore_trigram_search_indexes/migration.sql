-- Corrective migration. 20260917120000_trigram_search_indexes created 6 GIN
-- trigram indexes for fast ILIKE '%term%' search. Because those indexes are
-- raw-SQL-only (Prisma's schema syntax can't declare a custom GIN operator
-- class like gin_trgm_ops without extra setup), the very next migration,
-- 20260917123239_init, was auto-generated from a schema diff that didn't
-- know about them — Prisma's drift detection saw 4 of the 6 as "unexpected"
-- and dropped them:
--   Product_description_trgm_idx, Store_address_trgm_idx,
--   Store_description_trgm_idx, Store_district_trgm_idx
-- (Product_name_trgm_idx and Store_name_trgm_idx survived only because nothing
-- else in that diff touched them.)
--
-- Net effect on any database that ran the full chain — including this
-- project's live Railway database, which already reported "no pending
-- migrations" before this fix existed — is that search on
-- description/district/address silently fell back to full table scans.
-- Nothing crashed; it's a performance regression hiding behind green
-- migrations, and it gets worse as the catalog grows.
--
-- This migration is purely additive (CREATE INDEX IF NOT EXISTS) — safe to
-- run against a live database with prisma migrate deploy, no downtime, no
-- data risk. It does NOT fix the root cause by itself: see the comment
-- block above the Product/Store trigram indexes in schema.prisma for the
-- rule that prevents this from happening again.
CREATE INDEX IF NOT EXISTS "Product_description_trgm_idx" ON "Product" USING GIN ("description" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "Store_description_trgm_idx" ON "Store" USING GIN ("description" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "Store_district_trgm_idx" ON "Store" USING GIN ("district" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "Store_address_trgm_idx" ON "Store" USING GIN ("address" gin_trgm_ops);
