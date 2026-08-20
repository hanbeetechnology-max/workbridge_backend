-- Per-category push notification preferences (Settings > Notifications).
-- Independent of whether push is subscribed at all on this device — this
-- gates WHICH categories of event actually send a push once subscribed.
ALTER TABLE users ADD COLUMN IF NOT EXISTS notification_prefs JSONB NOT NULL
  DEFAULT '{"chat": true, "projects": true, "payments": true}'::jsonb;
