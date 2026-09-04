ALTER TABLE reports ADD COLUMN reporter_bucket BLOB;

CREATE UNIQUE INDEX reports_one_counted_vote_per_reporter_window
  ON reports (slug, reporter_bucket)
  WHERE status = 'counted' AND reporter_bucket IS NOT NULL;

CREATE INDEX reports_alt_phone_reporter_review
  ON reports (slug, alt_phone, reporter_bucket, status)
  WHERE alt_phone IS NOT NULL AND reporter_bucket IS NOT NULL;

CREATE TABLE report_rate_limits (
  rate_key TEXT PRIMARY KEY,
  request_count INTEGER NOT NULL CHECK (request_count > 0),
  expires_at INTEGER NOT NULL
);

CREATE INDEX report_rate_limits_expiry
  ON report_rate_limits (expires_at);
