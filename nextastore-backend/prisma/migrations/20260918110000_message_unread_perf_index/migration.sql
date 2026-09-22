-- The unread-count endpoint (GET /messages/unread-count, polled from every
-- logged-in page's nav badge every 20s) and the per-conversation unread
-- subquery on GET /messages/conversations both filter Message rows on
-- `readAt IS NULL AND senderId <> :me` scoped to a conversation. The
-- mark-as-read UPDATE on GET /messages/conversations/:id filters the same
-- way. None of that was covered by an index beyond `(conversationId,
-- createdAt)` — Postgres had to walk every message in a thread (or, for the
-- global unread count, every message in every conversation the user is a
-- party to) to find the handful that are actually unread. That cost grows
-- with total message history, which is exactly the wrong direction as the
-- platform's message volume grows.
--
-- A partial index — only rows where readAt IS NULL are indexed at all — is
-- the standard fix: the index stays small and cheap forever, because a
-- message drops out of it the moment it's read, regardless of how many
-- millions of already-read messages pile up in the table.
CREATE INDEX "Message_unread_by_conversation_idx"
    ON "Message" ("conversationId", "senderId")
    WHERE "readAt" IS NULL;
