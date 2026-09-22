-- Administrative control plane: account status, super-admin level, custom admin roles,
-- follow-ups and an auditable trail for sensitive administration actions.

CREATE TYPE "UserAccountStatus" AS ENUM ('active', 'suspended');
CREATE TYPE "AdminLevel" AS ENUM ('standard', 'super_admin');
CREATE TYPE "AdminFollowUpStatus" AS ENUM ('open', 'in_progress', 'done', 'cancelled');

ALTER TABLE "User"
  ADD COLUMN "accountStatus" "UserAccountStatus" NOT NULL DEFAULT 'active',
  ADD COLUMN "adminLevel" "AdminLevel" NOT NULL DEFAULT 'standard',
  ADD COLUMN "adminRoleId" TEXT;

-- Any administrator that already exists was the legacy all-powerful admin.
-- Preserve that access as super-admin so this migration cannot accidentally
-- lock an existing operator out of the new permission model.
UPDATE "User" SET "adminLevel" = 'super_admin' WHERE "role" = 'admin';

CREATE TABLE "AdminRole" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "permissions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AdminRole_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AdminRole_name_key" ON "AdminRole"("name");

CREATE TABLE "AdminFollowUp" (
  "id" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "note" TEXT NOT NULL DEFAULT '',
  "status" "AdminFollowUpStatus" NOT NULL DEFAULT 'open',
  "dueAt" TIMESTAMP(3),
  "relatedUserId" TEXT,
  "assignedToId" TEXT,
  "adminRoleId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "AdminFollowUp_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AdminAuditLog" (
  "id" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "targetType" TEXT NOT NULL,
  "targetId" TEXT,
  "targetUserId" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AdminAuditLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AdminFollowUp_status_dueAt_idx" ON "AdminFollowUp"("status", "dueAt");
CREATE INDEX "AdminFollowUp_relatedUserId_idx" ON "AdminFollowUp"("relatedUserId");
CREATE INDEX "AdminFollowUp_assignedToId_idx" ON "AdminFollowUp"("assignedToId");
CREATE INDEX "AdminAuditLog_actorId_createdAt_idx" ON "AdminAuditLog"("actorId", "createdAt");
CREATE INDEX "AdminAuditLog_targetType_targetId_idx" ON "AdminAuditLog"("targetType", "targetId");
CREATE INDEX "AdminAuditLog_targetUserId_createdAt_idx" ON "AdminAuditLog"("targetUserId", "createdAt");

ALTER TABLE "User" ADD CONSTRAINT "User_adminRoleId_fkey"
  FOREIGN KEY ("adminRoleId") REFERENCES "AdminRole"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AdminRole" ADD CONSTRAINT "AdminRole_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AdminFollowUp" ADD CONSTRAINT "AdminFollowUp_relatedUserId_fkey"
  FOREIGN KEY ("relatedUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AdminFollowUp" ADD CONSTRAINT "AdminFollowUp_assignedToId_fkey"
  FOREIGN KEY ("assignedToId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AdminFollowUp" ADD CONSTRAINT "AdminFollowUp_adminRoleId_fkey"
  FOREIGN KEY ("adminRoleId") REFERENCES "AdminRole"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AdminAuditLog" ADD CONSTRAINT "AdminAuditLog_actorId_fkey"
  FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AdminAuditLog" ADD CONSTRAINT "AdminAuditLog_targetUserId_fkey"
  FOREIGN KEY ("targetUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
