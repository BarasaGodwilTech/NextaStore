-- Add the draft/published flag used to gate public visibility until a
-- seller finishes onboarding and calls launch(). Existing production stores
-- are already live, so backfill them as published; only stores created
-- after this migration should start as drafts.

-- AlterTable
-- DEFAULT true here so every existing row backfills to published in the
-- same statement that adds the column.
ALTER TABLE "Store" ADD COLUMN "isPublished" BOOLEAN NOT NULL DEFAULT true;

-- Flip the default for stores created from this point forward — matches
-- the @default(false) in schema.prisma. Existing rows already backfilled
-- above are untouched by changing the column default.
ALTER TABLE "Store" ALTER COLUMN "isPublished" SET DEFAULT false;
