-- Phase 1 tables. positions/trades/shadows/skip_tracks/post_exit_tracks/safety_cache
-- are added in later phases when the modules that use them exist.

CREATE TABLE seen_mints (
  mint TEXT PRIMARY KEY,
  discovered_at INTEGER NOT NULL
);
CREATE INDEX idx_seen_mints_discovered_at ON seen_mints (discovered_at);

CREATE TABLE pending (
  mint TEXT PRIMARY KEY,
  discovered_at INTEGER NOT NULL,
  first_eligible_at INTEGER,
  no_pair_checks INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  last_checked_at INTEGER,
  last_gate_result TEXT
);

-- Generic key/value store: pause state, outage tracking, health counters,
-- last digest time, downtime-gap bookkeeping.
CREATE TABLE state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Audit trail: outage alerts, restarts, pause/resume, digest sends.
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  meta TEXT
);
CREATE INDEX idx_events_ts ON events (ts);
