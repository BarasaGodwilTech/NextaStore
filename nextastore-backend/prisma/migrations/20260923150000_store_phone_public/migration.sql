-- Lets a seller choose whether their phone number is shown to shoppers on
-- their public store page. The number itself (Store.phoneNumber) is
-- unaffected and stays required at the application layer for account
-- follow-up regardless of this setting.
--
-- Defaults to false so nothing changes for any existing store the moment
-- this column appears: a phone number that was never shown publicly before
-- (serializePublicStore never included it) stays not shown until the owner
-- actively opts in, in onboarding or Settings.
ALTER TABLE "Store" ADD COLUMN "phonePublic" BOOLEAN NOT NULL DEFAULT false;
