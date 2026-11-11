-- Staff Console, phase 3: sensitive-action PIN, trusted devices (risk-based MFA).
-- Additive only: every new column is nullable or has a default, so this is safe on a live database.
ALTER TABLE "StaffAccount" ADD COLUMN "pinHash" TEXT, ADD COLUMN "pinSetAt" TIMESTAMP(3), ADD COLUMN "pinFailed" INTEGER NOT NULL DEFAULT 0, ADD COLUMN "pinLockedUntil" TIMESTAMP(3);
ALTER TABLE "StaffSession" ADD COLUMN "deviceId" TEXT;

CREATE TABLE "StaffDevice" (
  "id" TEXT NOT NULL,
  "staffId" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "label" TEXT NOT NULL DEFAULT '',
  "userAgent" TEXT NOT NULL DEFAULT '',
  "firstIp" TEXT NOT NULL DEFAULT '',
  "lastIp" TEXT NOT NULL DEFAULT '',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "trustedUntil" TIMESTAMP(3) NOT NULL,
  "revokedAt" TIMESTAMP(3),
  CONSTRAINT "StaffDevice_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "StaffDevice_tokenHash_key" ON "StaffDevice"("tokenHash");
CREATE INDEX "StaffDevice_staffId_revokedAt_idx" ON "StaffDevice"("staffId", "revokedAt");
ALTER TABLE "StaffDevice" ADD CONSTRAINT "StaffDevice_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "StaffAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Message templates: the existing canned replies gain a kind (reply | email | notification) and a subject.
ALTER TABLE "CannedReply" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'reply', ADD COLUMN "subject" TEXT NOT NULL DEFAULT '';

-- Broadcasts: the receipt for a message sent to a whole group.
CREATE TABLE "Broadcast" (
  "id" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "subject" TEXT NOT NULL DEFAULT '',
  "body" TEXT NOT NULL,
  "audience" TEXT NOT NULL DEFAULT 'all',
  "channels" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "status" TEXT NOT NULL DEFAULT 'sending',
  "recipients" INTEGER NOT NULL DEFAULT 0,
  "inAppSent" INTEGER NOT NULL DEFAULT 0,
  "emailSent" INTEGER NOT NULL DEFAULT 0,
  "emailFailed" INTEGER NOT NULL DEFAULT 0,
  "sentById" TEXT,
  "sentByLabel" TEXT NOT NULL DEFAULT '',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt" TIMESTAMP(3),
  CONSTRAINT "Broadcast_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Broadcast_createdAt_idx" ON "Broadcast"("createdAt");

-- Staff messages show in the shopper/seller bell.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'staff_message';

-- New permissions for the built-in roles (custom roles are untouched; a Super Admin always holds every permission).
UPDATE "StaffRole" SET "permissions" = array_append("permissions", 'users.contact'), "updatedAt" = CURRENT_TIMESTAMP WHERE "key" = 'super_admin' AND "isSystem" = true AND NOT ('users.contact' = ANY("permissions"));
UPDATE "StaffRole" SET "permissions" = array_append("permissions", 'broadcasts.send'), "updatedAt" = CURRENT_TIMESTAMP WHERE "key" = 'super_admin' AND "isSystem" = true AND NOT ('broadcasts.send' = ANY("permissions"));
UPDATE "StaffRole" SET "permissions" = array_append("permissions", 'users.contact'), "updatedAt" = CURRENT_TIMESTAMP WHERE "key" = 'platform_admin' AND "isSystem" = true AND NOT ('users.contact' = ANY("permissions"));
UPDATE "StaffRole" SET "permissions" = array_append("permissions", 'broadcasts.send'), "updatedAt" = CURRENT_TIMESTAMP WHERE "key" = 'platform_admin' AND "isSystem" = true AND NOT ('broadcasts.send' = ANY("permissions"));
UPDATE "StaffRole" SET "permissions" = array_append("permissions", 'users.contact'), "updatedAt" = CURRENT_TIMESTAMP WHERE "key" = 'growth_manager' AND "isSystem" = true AND NOT ('users.contact' = ANY("permissions"));
UPDATE "StaffRole" SET "permissions" = array_append("permissions", 'broadcasts.send'), "updatedAt" = CURRENT_TIMESTAMP WHERE "key" = 'growth_manager' AND "isSystem" = true AND NOT ('broadcasts.send' = ANY("permissions"));
UPDATE "StaffRole" SET "permissions" = array_append("permissions", 'users.contact'), "updatedAt" = CURRENT_TIMESTAMP WHERE "key" = 'trust_safety_lead' AND "isSystem" = true AND NOT ('users.contact' = ANY("permissions"));
UPDATE "StaffRole" SET "permissions" = array_append("permissions", 'users.contact'), "updatedAt" = CURRENT_TIMESTAMP WHERE "key" = 'support_lead' AND "isSystem" = true AND NOT ('users.contact' = ANY("permissions"));
UPDATE "StaffRole" SET "permissions" = array_append("permissions", 'users.contact'), "updatedAt" = CURRENT_TIMESTAMP WHERE "key" = 'store_manager' AND "isSystem" = true AND NOT ('users.contact' = ANY("permissions"));
UPDATE "StaffRole" SET "permissions" = array_append("permissions", 'users.contact'), "updatedAt" = CURRENT_TIMESTAMP WHERE "key" = 'support_agent' AND "isSystem" = true AND NOT ('users.contact' = ANY("permissions"));

-- Starter templates (ids are fixed, so deleting one in the console never brings it back).
INSERT INTO "CannedReply" ("id","title","body","kind","subject","category","updatedAt") VALUES
  ('tpl_reply_order_on_way', 'Order is on its way', 'Hi {{first_name}}, thanks for your patience. Your order has been confirmed by the seller and is on its way. If it has not arrived within the delivery time they gave you, reply here and we will follow up with them straight away.

{{staff_name}}, NextaStore Support', 'reply', '', 'orders', CURRENT_TIMESTAMP),
  ('tpl_reply_need_details', 'We need a few more details', 'Hi {{first_name}}, we would like to help but need a little more information. Could you send us the order number, the store name, and a short description of what went wrong? A screenshot helps too.

{{staff_name}}, NextaStore Support', 'reply', '', 'general', CURRENT_TIMESTAMP),
  ('tpl_reply_payment_received', 'Seller Pass payment received', 'Hi {{first_name}}, we have received your Seller Pass payment and our finance team is confirming it now. This normally takes a few hours on working days. You will get a notification as soon as your store is renewed.

{{staff_name}}, NextaStore Support', 'reply', '', 'billing', CURRENT_TIMESTAMP),
  ('tpl_reply_account_unlocked', 'Account unlocked', 'Hi {{first_name}}, your account is open again and you can sign in. If you did not expect the lock, we recommend changing your password from Account settings.

{{staff_name}}, NextaStore Support', 'reply', '', 'account', CURRENT_TIMESTAMP),
  ('tpl_reply_closing', 'Closing the ticket', 'Hi {{first_name}}, we are glad this is sorted. We will close this ticket now, but you can reply any time and it will reopen.

{{staff_name}}, NextaStore Support', 'reply', '', 'general', CURRENT_TIMESTAMP),
  ('tpl_email_welcome_seller', 'Welcome, seller', 'Hi {{first_name}},

Welcome to NextaStore. The fastest way to get your first sale is to add 5 products with clear photos and share your store link on WhatsApp.

If you get stuck, reply to this email and a real person will help.

{{staff_name}}, NextaStore', 'email', 'Welcome to NextaStore, {{first_name}}', 'onboarding', CURRENT_TIMESTAMP),
  ('tpl_email_trial_ending', 'Free trial ending soon', 'Hi {{first_name}},

Your free trial is about to end. To keep your store visible to shoppers, activate your Seller Pass from the Subscription page. Choosing 6 months or more earns the seller badge after approval.

Need help paying? Reply and we will walk you through it.

{{staff_name}}, NextaStore', 'email', 'Your NextaStore trial ends soon', 'billing', CURRENT_TIMESTAMP),
  ('tpl_email_policy_warning', 'Policy reminder', 'Hi {{first_name}},

We noticed activity on your account that goes against our marketplace rules. Please review the rules and update your listings within 3 days. If we do not hear from you, we may have to restrict the listing.

If you think this is a mistake, just reply and tell us.

{{staff_name}}, NextaStore Trust & Safety', 'email', 'A reminder about marketplace rules', 'trust', CURRENT_TIMESTAMP),
  ('tpl_note_maintenance', 'Planned maintenance', 'NextaStore will be briefly unavailable tonight for maintenance. Your store and orders are safe.', 'notification', 'Planned maintenance tonight', 'platform', CURRENT_TIMESTAMP),
  ('tpl_note_new_feature', 'New feature announcement', 'We just launched something new for you. Open your dashboard to try it.', 'notification', 'Something new on NextaStore', 'platform', CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;
