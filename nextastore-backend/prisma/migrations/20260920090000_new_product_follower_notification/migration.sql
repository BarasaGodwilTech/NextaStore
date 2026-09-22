-- Follower notifications for new products (see helpers.js
-- notifyStoreFollowersOfNewProduct, called from POST /api/products). No new
-- table: it reuses the existing Notification model and StoreFollow
-- relation, so all this needs is one more enum value -- same pattern as
-- migration 20260914070000_seller_subscriptions adding 'subscription'.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'new_product';
