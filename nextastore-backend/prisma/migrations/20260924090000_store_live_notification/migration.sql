-- "Your store is live" notification, created when a seller launches from
-- onboarding (see routes/store.js PUT /). No new table: it reuses the
-- existing Notification model, so all this needs is one more enum value --
-- same pattern as 20260920090000_new_product_follower_notification.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'store_live';
