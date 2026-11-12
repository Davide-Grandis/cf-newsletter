CREATE TABLE IF NOT EXISTS update_jobs (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  actor TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued',
  phase TEXT NOT NULL DEFAULT 'queued',
  release_json TEXT NOT NULL,
  digest TEXT NOT NULL,
  installed_version TEXT NOT NULL,
  credential TEXT,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  finished_at INTEGER,
  error TEXT,
  checkpoint TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS update_lock (
  id INTEGER PRIMARY KEY CHECK(id=1),
  job_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS update_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  phase TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS update_events_job ON update_events(job_id,id);
CREATE TABLE IF NOT EXISTS update_cache (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  checked_at INTEGER NOT NULL
);
