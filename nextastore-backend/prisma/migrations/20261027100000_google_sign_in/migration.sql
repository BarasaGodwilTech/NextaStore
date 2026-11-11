-- Continue with Google: the Google account id of a person who has signed in with Google (null for password-only accounts).
ALTER TABLE "User" ADD COLUMN "googleId" TEXT;
CREATE UNIQUE INDEX "User_googleId_key" ON "User"("googleId");
