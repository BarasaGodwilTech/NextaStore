-- Every text search in the app (products.js GET /public, GET /:id search
-- via `q`; store.js GET /public/all and GET /search) filters with Prisma's
-- `contains` + `mode: 'insensitive'`, which Postgres executes as
-- `ILIKE '%term%'`. A plain B-tree index (what @@index([name]) in the
-- Prisma schema creates) cannot be used for a "contains" pattern at all —
-- Postgres falls back to a sequential scan of the whole table. That's
-- invisible with a few hundred rows and gets linearly slower as the
-- catalog grows into the thousands/tens of thousands, exactly the "search
-- feels slow as data grows" symptom. A trigram GIN index lets Postgres use
-- an index for ILIKE '%term%' regardless of where the match falls in the
-- string.
--
-- Requires the pg_trgm extension. Most managed Postgres providers (RDS,
-- Supabase, Neon, Render, etc.) allow enabling it without superuser; if
-- your provider rejects `CREATE EXTENSION`, enable pg_trgm from its
-- dashboard/console first, then re-run `prisma migrate deploy`.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS "Product_name_trgm_idx" ON "Product" USING GIN ("name" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "Product_description_trgm_idx" ON "Product" USING GIN ("description" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "Store_name_trgm_idx" ON "Store" USING GIN ("name" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "Store_description_trgm_idx" ON "Store" USING GIN ("description" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "Store_district_trgm_idx" ON "Store" USING GIN ("district" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "Store_address_trgm_idx" ON "Store" USING GIN ("address" gin_trgm_ops);
