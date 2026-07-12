-- Proactive completion and Mac presence notices are only useful while the
-- paired user is actively using the iMessage conversation. This timestamp is
-- updated exclusively by genuine inbound messages; existing bindings remain
-- NULL so deploying the feature cannot replay historical notifications.
ALTER TABLE phone_bindings ADD COLUMN last_user_message_at TEXT;

-- Stable completion ids let the service retry a provider/network failure
-- without repeating already accepted text parts. This table contains only
-- opaque ids and delivery counters, never task titles or response content.
CREATE TABLE IF NOT EXISTS completion_notifications (
  owner_id TEXT NOT NULL,
  completion_id TEXT NOT NULL,
  status TEXT NOT NULL,
  parts_sent INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  delivered_at TEXT,
  PRIMARY KEY (owner_id, completion_id)
);

CREATE INDEX IF NOT EXISTS completion_notifications_updated_idx
  ON completion_notifications(updated_at);
