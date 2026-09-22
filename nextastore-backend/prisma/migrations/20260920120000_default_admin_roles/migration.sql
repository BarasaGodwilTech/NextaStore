-- Starter admin roles for the role-based console. "Super Admin" is not a row
-- here: it is User.adminLevel = 'super_admin' and always holds every
-- permission. These three cover the common day-to-day jobs; a super admin can
-- edit or delete them, or add others, from Admin team.
--
-- Idempotent: an existing role with the same name (including one a super admin
-- already created or edited) is left exactly as it is.
INSERT INTO "AdminRole" ("id", "name", "description", "permissions", "updatedAt") VALUES
  ('seed_role_store_manager', 'Store Manager',
   'Looks after seller accounts and Seller Pass payments.',
   ARRAY['dashboard.view','users.view','users.edit','subscriptions.review','followups.manage'], CURRENT_TIMESTAMP),
  ('seed_role_support_agent', 'Support Agent',
   'Helps buyers and sellers: looks up accounts, starts password resets and works follow-ups.',
   ARRAY['dashboard.view','users.view','users.password_reset','followups.manage'], CURRENT_TIMESTAMP),
  ('seed_role_moderator', 'Moderator',
   'Handles Trust & Safety: reviews reports and suspends or reactivates accounts.',
   ARRAY['dashboard.view','users.view','users.suspend','reports.review','followups.manage'], CURRENT_TIMESTAMP)
ON CONFLICT ("name") DO NOTHING;
