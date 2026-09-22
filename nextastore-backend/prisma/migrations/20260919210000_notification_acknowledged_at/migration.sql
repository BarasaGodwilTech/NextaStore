-- Two-tier notification state (bell badge vs. item-level unread).
-- `readAt` (existing) keeps driving the per-item unread indicator, which
-- only clears when that specific notification is opened.
-- `acknowledgedAt` is new: it drives only the exterior bell badge, and
-- clears in bulk the instant the bell dropdown is opened, independent of
-- whether any individual item has been read. Every existing row gets
-- NULL (unacknowledged) by default, so nobody's badge silently changes
-- on deploy -- it settles the first time each user opens their bell.
ALTER TABLE "Notification" ADD COLUMN "acknowledgedAt" TIMESTAMP(3);
CREATE INDEX "Notification_userId_acknowledgedAt_idx" ON "Notification"("userId", "acknowledgedAt");
