CREATE TABLE reports_v3 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL,
  reached_human INTEGER NOT NULL CHECK (reached_human IN (0, 1)),
  seconds_bucket TEXT NOT NULL CHECK (seconds_bucket IN ('lt_60', '60_300', '300_900', 'gt_900')),
  steps_json TEXT,
  day TEXT NOT NULL CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  ip_bucket BLOB,
  reporter_bucket BLOB,
  status TEXT NOT NULL CHECK (status IN ('pending', 'counted', 'rejected')),
  CHECK (steps_json IS NULL OR json_valid(steps_json))
);

INSERT INTO reports_v3
  (id, slug, reached_human, seconds_bucket, steps_json, day, ip_bucket, reporter_bucket, status)
SELECT
  id, slug, reached_human, seconds_bucket, steps_json, day, ip_bucket, reporter_bucket, status
FROM reports
WHERE reporter_bucket IS NOT NULL;

DROP TABLE reports;
ALTER TABLE reports_v3 RENAME TO reports;

CREATE UNIQUE INDEX reports_one_counted_vote_per_day
  ON reports (slug, day, ip_bucket)
  WHERE status = 'counted' AND ip_bucket IS NOT NULL;

CREATE UNIQUE INDEX reports_one_counted_vote_per_reporter_window
  ON reports (slug, reporter_bucket)
  WHERE status = 'counted' AND reporter_bucket IS NOT NULL;

CREATE INDEX reports_slug_status_id
  ON reports (slug, status, id DESC);
