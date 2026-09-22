-- Finding 6 (revocation): a column for the middleware's tv/tokenVersion
-- check to compare against. Every existing row defaults to 0, matching
-- the 0 that a token with no `tv` claim (issued before this existed) is
-- already treated as in userFromAuthHeader — so running this migration
-- does not, by itself, log anyone out.
ALTER TABLE "User" ADD COLUMN "tokenVersion" INTEGER NOT NULL DEFAULT 0;
