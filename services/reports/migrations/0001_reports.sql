CREATE TABLE reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL,
  reached_human INTEGER NOT NULL CHECK (reached_human IN (0, 1)),
  seconds_bucket TEXT NOT NULL CHECK (seconds_bucket IN ('lt_60', '60_300', '300_900', 'gt_900')),
  steps_json TEXT,
  alt_phone TEXT,
  day TEXT NOT NULL CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  ip_bucket BLOB,
  status TEXT NOT NULL CHECK (status IN ('pending', 'counted', 'rejected')),
  CHECK (steps_json IS NULL OR json_valid(steps_json)),
  CHECK (alt_phone IS NULL OR reached_human = 0)
);

CREATE UNIQUE INDEX reports_one_counted_vote_per_day
  ON reports (slug, day, ip_bucket)
  WHERE status = 'counted' AND ip_bucket IS NOT NULL;

CREATE INDEX reports_slug_status_id
  ON reports (slug, status, id DESC);

CREATE INDEX reports_alt_phone_review
  ON reports (slug, alt_phone, status)
  WHERE alt_phone IS NOT NULL AND ip_bucket IS NOT NULL;

CREATE TABLE route_stats (
  slug TEXT PRIMARY KEY,
  up INTEGER NOT NULL DEFAULT 0 CHECK (up >= 0),
  down INTEGER NOT NULL DEFAULT 0 CHECK (down >= 0),
  last_confirmed_day TEXT,
  median_seconds INTEGER,
  sample_count INTEGER NOT NULL DEFAULT 0 CHECK (sample_count >= 0),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
