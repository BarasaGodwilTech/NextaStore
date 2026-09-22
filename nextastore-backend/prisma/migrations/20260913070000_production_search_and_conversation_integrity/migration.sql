-- Production search/indexing and conversation integrity.
-- Keep general (no-product) buyer/store conversations unique; PostgreSQL
-- treats NULLs as distinct in a normal UNIQUE constraint. If old data already
-- contains duplicate general threads, retain the oldest and move its messages
-- into that canonical conversation before creating the constraint.
WITH duplicates AS (
    SELECT "buyerId", "storeId", MIN("id") AS keep_id
    FROM "Conversation"
    WHERE "productId" IS NULL
    GROUP BY "buyerId", "storeId"
    HAVING COUNT(*) > 1
),
moved AS (
    UPDATE "Message" m
    SET "conversationId" = d.keep_id
    FROM "Conversation" c
    JOIN duplicates d ON d."buyerId" = c."buyerId" AND d."storeId" = c."storeId"
    WHERE c."productId" IS NULL AND c."id" <> d.keep_id
    RETURNING c."id"
)
DELETE FROM "Conversation" c
USING duplicates d
WHERE c."productId" IS NULL
  AND c."buyerId" = d."buyerId"
  AND c."storeId" = d."storeId"
  AND c."id" <> d.keep_id;

CREATE UNIQUE INDEX IF NOT EXISTS "Conversation_buyerId_storeId_general_key"
ON "Conversation" ("buyerId", "storeId")
WHERE "productId" IS NULL;

-- Trigram indexes accelerate case-insensitive name search as the catalog grows.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS "Store_name_trgm_idx"
ON "Store" USING GIN ("name" gin_trgm_ops)
WHERE "deletedAt" IS NULL;
CREATE INDEX IF NOT EXISTS "Product_name_trgm_idx"
ON "Product" USING GIN ("name" gin_trgm_ops)
WHERE "deletedAt" IS NULL;

CREATE INDEX IF NOT EXISTS "Product_storeId_createdAt_idx"
ON "Product" ("storeId", "createdAt")
WHERE "deletedAt" IS NULL;
CREATE INDEX IF NOT EXISTS "Product_storeId_sold_idx"
ON "Product" ("storeId", "sold")
WHERE "deletedAt" IS NULL;
CREATE INDEX IF NOT EXISTS "Product_storeId_price_idx"
ON "Product" ("storeId", "price")
WHERE "deletedAt" IS NULL;
CREATE INDEX IF NOT EXISTS "Store_rating_idx"
ON "Store" ("rating")
WHERE "deletedAt" IS NULL;
CREATE INDEX IF NOT EXISTS "Notification_userId_createdAt_idx"
ON "Notification" ("userId", "createdAt");
DROP INDEX IF EXISTS "Store_slug_idx";

CREATE INDEX IF NOT EXISTS "Product_sold_idx"
ON "Product" ("sold")
WHERE "deletedAt" IS NULL;

CREATE INDEX IF NOT EXISTS "Message_conversationId_createdAt_idx"
ON "Message" ("conversationId", "createdAt");

CREATE INDEX IF NOT EXISTS "Store_createdAt_idx"
ON "Store" ("createdAt")
WHERE "deletedAt" IS NULL;
CREATE INDEX IF NOT EXISTS "Product_name_idx"
ON "Product" ("name");
