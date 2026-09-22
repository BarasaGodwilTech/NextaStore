-- AlterTable
-- Item 5 (thumbnails): small variants of Product.images, generated
-- client-side at upload time so marketplace/store grids don't have to load
-- full-resolution photos. Defaults to an empty array so every existing
-- product row is valid immediately; serializeProduct() falls back to
-- images/image for any product that predates this column.
ALTER TABLE "Product" ADD COLUMN "thumbnails" JSONB NOT NULL DEFAULT '[]';
