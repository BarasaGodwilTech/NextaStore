-- Staff Console: administrators stop being rows in "User".
--
-- BEFORE: an admin was a User with role = 'admin', signed in through the same /login page and the same JWT as every shopper, and
--         could use the whole shopper site (cart, orders, messages ...).
-- AFTER:  staff live in their own tables ("StaffAccount", "StaffRole", "StaffSession", "StaffToken"), sign in on their own page with
--         mandatory two-step verification, and have no shopper account at all. The "User" table can no longer hold an admin.
--
-- Existing admins are carried over with the SAME id (so audit rows and "reviewed by" columns keep pointing at the right person),
-- keep their password hash, but must set a new password and enrol two-step verification at first sign-in. Their shopper-side rows
-- (notifications, push subscriptions, tokens ...) are deleted with them. Take a backup before running this.

-- 1. Enums -----------------------------------------------------------------------------------------------------------------------
CREATE TYPE "StaffStatus" AS ENUM ('invited', 'active', 'suspended');
CREATE TYPE "StaffTokenType" AS ENUM ('invite', 'password_reset');
CREATE TYPE "ModerationStatus" AS ENUM ('ok', 'restricted');
CREATE TYPE "TicketStatus" AS ENUM ('open', 'pending', 'resolved', 'closed');
CREATE TYPE "TicketPriority" AS ENUM ('low', 'normal', 'high', 'urgent');
CREATE TYPE "TicketAuthorKind" AS ENUM ('customer', 'staff', 'system');

-- 2. Let go of every foreign key that points an admin concept at "User" or "AdminRole" -----------------------------------------------
ALTER TABLE "User" DROP CONSTRAINT "User_adminRoleId_fkey";
ALTER TABLE "AdminRole" DROP CONSTRAINT "AdminRole_createdById_fkey";
ALTER TABLE "AdminFollowUp" DROP CONSTRAINT "AdminFollowUp_assignedToId_fkey";
ALTER TABLE "AdminFollowUp" DROP CONSTRAINT "AdminFollowUp_adminRoleId_fkey";
ALTER TABLE "AdminAuditLog" DROP CONSTRAINT "AdminAuditLog_actorId_fkey";

-- 3. New staff tables ------------------------------------------------------------------------------------------------------------------
CREATE TABLE "StaffRole" (
  "id" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "permissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "rank" INTEGER NOT NULL DEFAULT 10,
  "isSystem" BOOLEAN NOT NULL DEFAULT false,
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StaffRole_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "StaffRole_key_key" ON "StaffRole"("key");
CREATE UNIQUE INDEX "StaffRole_name_key" ON "StaffRole"("name");

CREATE TABLE "StaffAccount" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "passwordHash" TEXT NOT NULL,
  "jobTitle" TEXT NOT NULL DEFAULT '',
  "roleId" TEXT NOT NULL,
  "status" "StaffStatus" NOT NULL DEFAULT 'invited',
  "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
  "passwordChangedAt" TIMESTAMP(3),
  "mfaSecretEnc" TEXT,
  "mfaEnabledAt" TIMESTAMP(3),
  "mfaLastStep" INTEGER,
  "recoveryCodeHashes" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "failedLogins" INTEGER NOT NULL DEFAULT 0,
  "lockedUntil" TIMESTAMP(3),
  "lastLoginAt" TIMESTAMP(3),
  "lastLoginIp" TEXT,
  "tokenVersion" INTEGER NOT NULL DEFAULT 0,
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StaffAccount_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "StaffAccount_email_key" ON "StaffAccount"("email");
CREATE INDEX "StaffAccount_roleId_idx" ON "StaffAccount"("roleId");
CREATE INDEX "StaffAccount_status_idx" ON "StaffAccount"("status");

CREATE TABLE "StaffSession" (
  "id" TEXT NOT NULL,
  "staffId" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "csrfToken" TEXT NOT NULL,
  "ip" TEXT NOT NULL DEFAULT '',
  "userAgent" TEXT NOT NULL DEFAULT '',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "reauthAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revokedAt" TIMESTAMP(3),
  "revokedReason" TEXT,
  CONSTRAINT "StaffSession_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "StaffSession_tokenHash_key" ON "StaffSession"("tokenHash");
CREATE INDEX "StaffSession_staffId_revokedAt_idx" ON "StaffSession"("staffId", "revokedAt");
CREATE INDEX "StaffSession_expiresAt_idx" ON "StaffSession"("expiresAt");

CREATE TABLE "StaffToken" (
  "id" TEXT NOT NULL,
  "staffId" TEXT NOT NULL,
  "type" "StaffTokenType" NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "usedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StaffToken_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "StaffToken_tokenHash_key" ON "StaffToken"("tokenHash");
CREATE INDEX "StaffToken_staffId_type_idx" ON "StaffToken"("staffId", "type");

-- 4. System roles, then any custom roles super admins had already made --------------------------------------------------------------
INSERT INTO "StaffRole" ("id","key","name","description","permissions","rank","isSystem","updatedAt") VALUES
  ('sys_role_super_admin', 'super_admin', 'Super Admin', 'Owns the platform. Holds every permission, including staff, roles and security. Keep this to as few people as possible.', ARRAY['dashboard.view','analytics.view','users.view','users.edit','users.suspend','users.password_reset','users.sessions','users.notes','stores.view','stores.manage','products.view','products.moderate','orders.view','orders.manage','reports.review','finance.view','subscriptions.review','tickets.view','tickets.manage','canned.manage','followups.manage','nexi.view','announcements.manage','growth.view','growth.review','growth.payouts','growth.settings','settings.manage','staff.view','staff.manage','roles.manage','security.manage','audit.view','audit.export']::TEXT[], 100, true, CURRENT_TIMESTAMP),
  ('sys_role_platform_admin', 'platform_admin', 'Platform Admin', 'Runs day-to-day operations across the marketplace. Cannot manage staff, roles or security.', ARRAY['dashboard.view','analytics.view','users.view','users.edit','users.suspend','users.password_reset','users.sessions','users.notes','stores.view','stores.manage','products.view','products.moderate','orders.view','orders.manage','reports.review','finance.view','subscriptions.review','tickets.view','tickets.manage','canned.manage','followups.manage','nexi.view','announcements.manage','growth.view','growth.review','growth.payouts','growth.settings','settings.manage','staff.view','audit.view','audit.export']::TEXT[], 80, true, CURRENT_TIMESTAMP),
  ('sys_role_finance_manager', 'finance_manager', 'Finance Manager', 'Approves Seller Pass payments and Circle / Crew payouts. Reads the payment ledger.', ARRAY['dashboard.view','analytics.view','users.view','stores.view','finance.view','subscriptions.review','growth.view','growth.payouts','followups.manage','audit.view']::TEXT[], 60, true, CURRENT_TIMESTAMP),
  ('sys_role_growth_manager', 'growth_manager', 'Growth Manager', 'Runs the Circle and Crew programmes: approvals, campaigns and settings. Cannot pay withdrawals.', ARRAY['dashboard.view','analytics.view','users.view','stores.view','growth.view','growth.review','growth.settings','announcements.manage','followups.manage']::TEXT[], 60, true, CURRENT_TIMESTAMP),
  ('sys_role_trust_safety_lead', 'trust_safety_lead', 'Trust & Safety Lead', 'Leads moderation: reports, account suspensions, store restrictions and product removals.', ARRAY['dashboard.view','users.view','users.suspend','users.sessions','users.notes','stores.view','stores.manage','products.view','products.moderate','orders.view','orders.manage','reports.review','tickets.view','tickets.manage','followups.manage','audit.view']::TEXT[], 60, true, CURRENT_TIMESTAMP),
  ('sys_role_support_lead', 'support_lead', 'Support Lead', 'Runs the support desk: all ticket tools, canned replies, password resets and sign-outs.', ARRAY['dashboard.view','analytics.view','users.view','users.password_reset','users.sessions','users.notes','stores.view','orders.view','tickets.view','tickets.manage','canned.manage','followups.manage','nexi.view']::TEXT[], 50, true, CURRENT_TIMESTAMP),
  ('sys_role_moderator', 'moderator', 'Moderator', 'Handles Trust & Safety: reviews reports, hides listings and suspends or reactivates accounts.', ARRAY['dashboard.view','users.view','users.suspend','users.notes','stores.view','products.view','products.moderate','orders.view','reports.review','followups.manage']::TEXT[], 40, true, CURRENT_TIMESTAMP),
  ('sys_role_store_manager', 'store_manager', 'Store Manager', 'Looks after seller accounts, their stores and Seller Pass payments.', ARRAY['dashboard.view','users.view','users.edit','users.notes','stores.view','stores.manage','products.view','subscriptions.review','tickets.view','tickets.manage','followups.manage']::TEXT[], 40, true, CURRENT_TIMESTAMP),
  ('sys_role_support_agent', 'support_agent', 'Support Agent', 'Helps shoppers and sellers: answers tickets, looks up accounts and orders, sends password resets.', ARRAY['dashboard.view','users.view','users.password_reset','users.notes','stores.view','orders.view','tickets.view','tickets.manage','followups.manage','nexi.view']::TEXT[], 30, true, CURRENT_TIMESTAMP),
  ('sys_role_auditor', 'auditor', 'Auditor', 'Read-only oversight: audit log, staff directory and the payment ledger. Cannot change anything.', ARRAY['dashboard.view','analytics.view','finance.view','staff.view','audit.view','audit.export']::TEXT[], 20, true, CURRENT_TIMESTAMP),
  ('sys_role_support_trainee', 'support_trainee', 'Support Trainee', 'Read-only support access for people in training: can look things up but cannot change anything.', ARRAY['dashboard.view','users.view','stores.view','orders.view','tickets.view']::TEXT[], 10, true, CURRENT_TIMESTAMP),
  ('sys_role_no_access', 'no_access', 'No access', 'Placeholder for an account whose role was removed. Signs in but can do nothing until a role is assigned.', ARRAY[]::TEXT[], 0, true, CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;

-- Custom roles keep their name and permissions. 'admins.manage' was renamed 'staff.manage'. They rank 10: they can hold access, but
-- cannot manage anyone until a Super Admin raises the rank. A custom role that reuses a system role's name maps to that system role.
INSERT INTO "StaffRole" ("id", "key", "name", "description", "permissions", "rank", "isSystem", "updatedAt")
SELECT ar."id", 'custom_' || ar."id", ar."name", ar."description",
       ARRAY(SELECT CASE WHEN p = 'admins.manage' THEN 'staff.manage' ELSE p END FROM unnest(ar."permissions") AS p),
       10, false, CURRENT_TIMESTAMP
FROM "AdminRole" ar
WHERE ar."name" NOT IN (SELECT "name" FROM "StaffRole");

-- 5. Carry every administrator over (same id), then remember who audit rows belonged to ----------------------------------------------
ALTER TABLE "AdminAuditLog" ADD COLUMN "actorLabel" TEXT NOT NULL DEFAULT '';
ALTER TABLE "AdminAuditLog" ADD COLUMN "ip" TEXT NOT NULL DEFAULT '';
ALTER TABLE "AdminAuditLog" ADD COLUMN "userAgent" TEXT NOT NULL DEFAULT '';
ALTER TABLE "AdminAuditLog" ALTER COLUMN "actorId" DROP NOT NULL;
UPDATE "AdminAuditLog" a SET "actorLabel" = u."name" || ' <' || u."email" || '>' FROM "User" u WHERE a."actorId" = u."id";

INSERT INTO "StaffAccount" ("id", "name", "email", "passwordHash", "roleId", "status", "mustChangePassword", "tokenVersion", "createdAt", "updatedAt")
SELECT u."id", u."name", u."email", u."passwordHash",
       CASE
         WHEN u."adminLevel" = 'super_admin' THEN 'sys_role_super_admin'
         ELSE COALESCE((SELECT sr."id" FROM "AdminRole" ar JOIN "StaffRole" sr ON sr."name" = ar."name" WHERE ar."id" = u."adminRoleId"), 'sys_role_no_access')
       END,
       CASE WHEN u."accountStatus" = 'suspended' THEN 'suspended'::"StaffStatus" ELSE 'active'::"StaffStatus" END,
       true, u."tokenVersion" + 1, u."createdAt", CURRENT_TIMESTAMP
FROM "User" u WHERE u."role" = 'admin';

-- Follow-ups and audit rows that pointed at an admin who is no longer one (or at a role that no longer exists) lose that link.
UPDATE "AdminFollowUp" f SET "adminRoleId" = sr."id" FROM "AdminRole" ar JOIN "StaffRole" sr ON sr."name" = ar."name" WHERE f."adminRoleId" = ar."id";
UPDATE "AdminFollowUp" SET "adminRoleId" = NULL WHERE "adminRoleId" IS NOT NULL AND "adminRoleId" NOT IN (SELECT "id" FROM "StaffRole");
UPDATE "AdminFollowUp" SET "assignedToId" = NULL WHERE "assignedToId" IS NOT NULL AND "assignedToId" NOT IN (SELECT "id" FROM "StaffAccount");
UPDATE "AdminAuditLog" SET "actorId" = NULL WHERE "actorId" IS NOT NULL AND "actorId" NOT IN (SELECT "id" FROM "StaffAccount");

-- 6. Remove administrators from the shopper side for good -----------------------------------------------------------------------------
DELETE FROM "User" WHERE "role" = 'admin';
ALTER TABLE "User" DROP COLUMN "adminLevel";
ALTER TABLE "User" DROP COLUMN "adminRoleId";
DROP TABLE "AdminRole";
DROP TYPE "AdminLevel";

ALTER TYPE "UserRole" RENAME TO "UserRole_old";
CREATE TYPE "UserRole" AS ENUM ('buyer', 'seller');
ALTER TABLE "User" ALTER COLUMN "role" DROP DEFAULT;
ALTER TABLE "User" ALTER COLUMN "role" TYPE "UserRole" USING ("role"::text::"UserRole");
ALTER TABLE "User" ALTER COLUMN "role" SET DEFAULT 'buyer';
DROP TYPE "UserRole_old";

-- 7. Foreign keys for the new tables --------------------------------------------------------------------------------------------------
ALTER TABLE "StaffRole" ADD CONSTRAINT "StaffRole_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "StaffAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "StaffAccount" ADD CONSTRAINT "StaffAccount_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "StaffRole"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StaffAccount" ADD CONSTRAINT "StaffAccount_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "StaffAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "StaffSession" ADD CONSTRAINT "StaffSession_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "StaffAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StaffToken" ADD CONSTRAINT "StaffToken_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "StaffAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AdminFollowUp" ADD CONSTRAINT "AdminFollowUp_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "StaffAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AdminFollowUp" ADD CONSTRAINT "AdminFollowUp_adminRoleId_fkey" FOREIGN KEY ("adminRoleId") REFERENCES "StaffRole"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AdminAuditLog" ADD CONSTRAINT "AdminAuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "StaffAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "AdminAuditLog_action_createdAt_idx" ON "AdminAuditLog"("action", "createdAt");
CREATE INDEX "AdminAuditLog_createdAt_idx" ON "AdminAuditLog"("createdAt");

-- 8. Store and product moderation -------------------------------------------------------------------------------------------------------
ALTER TABLE "Store" ADD COLUMN "moderationStatus" "ModerationStatus" NOT NULL DEFAULT 'ok',
  ADD COLUMN "moderationNote" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "moderatedAt" TIMESTAMP(3),
  ADD COLUMN "moderatedBy" TEXT;
ALTER TABLE "Product" ADD COLUMN "moderationStatus" "ModerationStatus" NOT NULL DEFAULT 'ok',
  ADD COLUMN "moderationNote" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "moderatedAt" TIMESTAMP(3),
  ADD COLUMN "moderatedBy" TEXT;

-- 9. Support desk, notes, announcements ---------------------------------------------------------------------------------------------------
CREATE TABLE "SupportTicket" (
  "id" TEXT NOT NULL,
  "number" SERIAL NOT NULL,
  "subject" TEXT NOT NULL,
  "category" TEXT NOT NULL DEFAULT 'general',
  "status" "TicketStatus" NOT NULL DEFAULT 'open',
  "priority" "TicketPriority" NOT NULL DEFAULT 'normal',
  "requesterId" TEXT,
  "requesterName" TEXT NOT NULL DEFAULT '',
  "requesterEmail" TEXT NOT NULL DEFAULT '',
  "assigneeId" TEXT,
  "relatedOrderId" TEXT,
  "source" TEXT NOT NULL DEFAULT 'web',
  "slaDueAt" TIMESTAMP(3),
  "firstResponseAt" TIMESTAMP(3),
  "resolvedAt" TIMESTAMP(3),
  "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SupportTicket_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SupportTicket_number_key" ON "SupportTicket"("number");
CREATE INDEX "SupportTicket_status_priority_idx" ON "SupportTicket"("status", "priority");
CREATE INDEX "SupportTicket_assigneeId_status_idx" ON "SupportTicket"("assigneeId", "status");
CREATE INDEX "SupportTicket_requesterId_idx" ON "SupportTicket"("requesterId");
CREATE INDEX "SupportTicket_slaDueAt_idx" ON "SupportTicket"("slaDueAt");
CREATE INDEX "SupportTicket_lastMessageAt_idx" ON "SupportTicket"("lastMessageAt");

CREATE TABLE "SupportTicketMessage" (
  "id" TEXT NOT NULL,
  "ticketId" TEXT NOT NULL,
  "authorKind" "TicketAuthorKind" NOT NULL,
  "authorStaffId" TEXT,
  "authorName" TEXT NOT NULL DEFAULT '',
  "body" TEXT NOT NULL,
  "isInternal" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SupportTicketMessage_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "SupportTicketMessage_ticketId_createdAt_idx" ON "SupportTicketMessage"("ticketId", "createdAt");

CREATE TABLE "CannedReply" (
  "id" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "category" TEXT NOT NULL DEFAULT 'general',
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CannedReply_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "UserNote" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "authorId" TEXT,
  "authorName" TEXT NOT NULL DEFAULT '',
  "body" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UserNote_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "UserNote_userId_createdAt_idx" ON "UserNote"("userId", "createdAt");

CREATE TABLE "Announcement" (
  "id" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "body" TEXT NOT NULL DEFAULT '',
  "tone" TEXT NOT NULL DEFAULT 'info',
  "audience" TEXT NOT NULL DEFAULT 'all',
  "isActive" BOOLEAN NOT NULL DEFAULT false,
  "startsAt" TIMESTAMP(3),
  "endsAt" TIMESTAMP(3),
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Announcement_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Announcement_isActive_startsAt_endsAt_idx" ON "Announcement"("isActive", "startsAt", "endsAt");

ALTER TABLE "SupportTicket" ADD CONSTRAINT "SupportTicket_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SupportTicket" ADD CONSTRAINT "SupportTicket_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "StaffAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SupportTicketMessage" ADD CONSTRAINT "SupportTicketMessage_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "SupportTicket"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SupportTicketMessage" ADD CONSTRAINT "SupportTicketMessage_authorStaffId_fkey" FOREIGN KEY ("authorStaffId") REFERENCES "StaffAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "UserNote" ADD CONSTRAINT "UserNote_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UserNote" ADD CONSTRAINT "UserNote_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "StaffAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
