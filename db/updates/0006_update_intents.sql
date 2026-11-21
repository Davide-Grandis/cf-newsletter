CREATE TABLE IF NOT EXISTS update_intents (
  id TEXT PRIMARY KEY,
  release_id INTEGER NOT NULL,
  digest TEXT NOT NULL,
  version TEXT NOT NULL,
  actor TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
