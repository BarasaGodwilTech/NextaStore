-- Store directory at scale: the public "All stores" list filters on isPublished and orders by
-- verified/createdAt (featured, newest) or name (A to Z). Plain composite indexes; the trigram
-- search indexes are untouched.
CREATE INDEX IF NOT EXISTS "Store_isPublished_verified_createdAt_idx" ON "Store"("isPublished", "verified", "createdAt");
CREATE INDEX IF NOT EXISTS "Store_isPublished_name_idx" ON "Store"("isPublished", "name");
