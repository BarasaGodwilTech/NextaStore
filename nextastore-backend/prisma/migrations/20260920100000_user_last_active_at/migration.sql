-- Presence: last time a person was seen connected.
--
-- Nullable and with no default on purpose: adding it changes nothing for
-- anyone until they next connect, and "never seen" is a real state the UI
-- handles (it shows plain "Offline" rather than a made-up timestamp).
--
-- Deliberately NOT indexed: it is only ever read by primary key (a
-- conversation's other party, a store's owner), never searched or sorted by,
-- so an index would only add write cost to a column that is updated often.
ALTER TABLE "User" ADD COLUMN "lastActiveAt" TIMESTAMP(3);
