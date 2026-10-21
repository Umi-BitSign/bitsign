CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('uploading', 'queued', 'processing', 'complete', 'failed', 'deleted')),
  stage TEXT NOT NULL,
  object_key TEXT NOT NULL,
  content_type TEXT NOT NULL,
  example_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  started_at INTEGER,
  lease_id TEXT,
  lease_until INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  text TEXT,
  error TEXT,
  elapsed_seconds REAL,
  deleted_at INTEGER
);
CREATE INDEX jobs_active ON jobs(status, expires_at);
CREATE INDEX jobs_expiry ON jobs(expires_at);
CREATE TABLE rate_events (job_id TEXT PRIMARY KEY, ip_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX rate_events_window ON rate_events(ip_hash, created_at);
CREATE TRIGGER jobs_rate_event AFTER INSERT ON jobs BEGIN
  INSERT INTO rate_events(job_id, ip_hash, created_at) VALUES (NEW.id, NEW.ip_hash, NEW.created_at);
END;
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO settings(key, value) VALUES ('rate_salt', lower(hex(randomblob(32))));
