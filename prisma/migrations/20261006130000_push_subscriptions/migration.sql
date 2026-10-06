-- Push notification subscriptions
CREATE TABLE IF NOT EXISTS PushSubscription (
  id TEXT PRIMARY KEY,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  createdAt TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pushsub_endpoint ON PushSubscription(endpoint);
