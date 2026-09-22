-- Adds rich attachment support to chat messages: a seller sharing another
-- product from their own catalog inside a conversation, or either party
-- sharing a location. See schema.prisma's MessageType/Message.metadata
-- comments for the payload shapes. Every existing row is a plain text
-- message, which is exactly what the column defaults backfill them to.

CREATE TYPE "MessageType" AS ENUM ('text', 'product', 'location');

ALTER TABLE "Message" ADD COLUMN "type" "MessageType" NOT NULL DEFAULT 'text';
ALTER TABLE "Message" ADD COLUMN "metadata" JSONB NOT NULL DEFAULT '{}';
