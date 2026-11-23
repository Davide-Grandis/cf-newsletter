ALTER TABLE sends ADD COLUMN batch_id TEXT;
ALTER TABLE sends ADD COLUMN claimed_at TEXT;
ALTER TABLE sends ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sends ADD COLUMN next_attempt_at TEXT;
CREATE INDEX IF NOT EXISTS idx_sends_dispatch ON sends(status, batch_id, campaign_id);
CREATE TABLE IF NOT EXISTS dispatch_state (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  next_tick_at INTEGER,
  locked_until INTEGER,
  paused_until INTEGER,
  pause_reason TEXT
);
INSERT OR IGNORE INTO dispatch_state (id) VALUES (1);
