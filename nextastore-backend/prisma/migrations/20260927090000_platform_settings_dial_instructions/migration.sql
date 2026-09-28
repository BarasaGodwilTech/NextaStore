-- Sellers on Seller Pass were shown a merchant code and name for MTN MoMo /
-- Airtel Money but no guidance on what to actually dial to send it. These two
-- columns hold short, admin-editable dial instructions per method (e.g. "Dial
-- *165*3*171145*<amount>#, enter your PIN, then confirm.") so support does not
-- have to hardcode them into the frontend and can update wording if MTN/Airtel
-- change their USSD menu. Both default to empty: the instructions block is
-- hidden on the frontend until an admin fills one in.
ALTER TABLE "PlatformSettings" ADD COLUMN "mtnMomoInstructions" TEXT NOT NULL DEFAULT '';
ALTER TABLE "PlatformSettings" ADD COLUMN "airtelMoneyInstructions" TEXT NOT NULL DEFAULT '';
