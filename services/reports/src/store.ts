import type { PhoneReport, RouteStats } from './types';

interface StatsRow {
  slug: string;
  up: number;
  down: number;
  last_confirmed_day: string | null;
  median_seconds: number | null;
  sample_count: number;
  stale: number;
}

function blob(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export async function writeCountedReport(
  db: D1Database,
  report: PhoneReport,
  bucket: Uint8Array,
  reporter: Uint8Array,
  day: string,
): Promise<{ replaced: boolean }> {
  const ip = blob(bucket);
  const reporterId = blob(reporter);
  const existing = await db.prepare(`
    SELECT 1 AS present
    FROM reports
    WHERE slug = ?1 AND status = 'counted'
      AND (reporter_bucket = ?4 OR (reporter_bucket IS NULL AND day = ?2 AND ip_bucket = ?3))
    LIMIT 1
  `).bind(report.slug, day, ip, reporterId).first<{ present: number }>();
  const results = await db.batch([
    db.prepare(`
      UPDATE reports SET status = 'rejected'
      WHERE slug = ?1 AND status = 'counted' AND reporter_bucket IS NULL
        AND day = ?2 AND ip_bucket = ?3
    `).bind(report.slug, day, ip),
    db.prepare(`
      INSERT INTO reports
        (slug, reached_human, seconds_bucket, steps_json, day, ip_bucket, reporter_bucket, status)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'counted')
      ON CONFLICT(slug, reporter_bucket)
        WHERE status = 'counted' AND reporter_bucket IS NOT NULL
      DO UPDATE SET
        reached_human = excluded.reached_human,
        seconds_bucket = excluded.seconds_bucket,
        steps_json = excluded.steps_json,
        day = excluded.day,
        ip_bucket = excluded.ip_bucket
    `).bind(
      report.slug,
      report.reachedHuman ? 1 : 0,
      report.secondsBucket,
      report.steps ? JSON.stringify(report.steps) : null,
      day,
      ip,
      reporterId,
    ),
  ]);
  return { replaced: Boolean(existing) || Number(results[0]?.meta?.changes ?? 0) > 0 };
}

function rowToStats(row: StatsRow): RouteStats {
  return {
    slug: row.slug,
    up: Number(row.up),
    down: Number(row.down),
    lastConfirmedDay: row.last_confirmed_day,
    medianSeconds: row.median_seconds === null ? null : Number(row.median_seconds),
    sampleCount: Number(row.sample_count),
    stale: Boolean(row.stale),
  };
}

function statsQuery(whereClause: string, reportWhereClause = ''): string {
  return `
    WITH recent AS (
      SELECT slug, reached_human
      FROM (
        SELECT
          slug,
          reached_human,
          ROW_NUMBER() OVER (PARTITION BY slug ORDER BY id DESC) AS report_position
        FROM reports
        WHERE status = 'counted' AND reporter_bucket IS NOT NULL ${reportWhereClause}
      )
      WHERE report_position <= 30
    ),
    health AS (
      SELECT
        slug,
        COUNT(*) AS recent_count,
        SUM(CASE WHEN reached_human = 0 THEN 1 ELSE 0 END) AS recent_down
      FROM recent
      GROUP BY slug
    )
    SELECT
      stats.slug,
      stats.up,
      stats.down,
      stats.last_confirmed_day,
      stats.median_seconds,
      stats.sample_count,
      CASE
        WHEN COALESCE(health.recent_count, 0) >= 5
          AND health.recent_down * 1.0 / health.recent_count > 0.4
        THEN 1 ELSE 0
      END AS stale
    FROM route_stats AS stats
    LEFT JOIN health ON health.slug = stats.slug
    ${whereClause}
    ORDER BY stats.slug
  `;
}

export async function readAllStats(db: D1Database): Promise<RouteStats[]> {
  const result = await db.prepare(statsQuery('')).all<StatsRow>();
  return result.results.map(rowToStats);
}

export const RECOMPUTE_ALL_STATS_SQL = `
  WITH aggregates AS (
    SELECT
      slug,
      SUM(CASE WHEN reached_human = 1 THEN 1 ELSE 0 END) AS up,
      SUM(CASE WHEN reached_human = 0 THEN 1 ELSE 0 END) AS down,
      MAX(CASE WHEN reached_human = 1 THEN day ELSE NULL END) AS last_confirmed_day,
      SUM(CASE WHEN reached_human = 1 THEN 1 ELSE 0 END) AS sample_count
    FROM reports
    WHERE status = 'counted' AND reporter_bucket IS NOT NULL
    GROUP BY slug
    HAVING COUNT(DISTINCT hex(reporter_bucket)) >= 3
  ),
  bucket_counts AS (
    SELECT
      slug,
      CASE seconds_bucket
        WHEN 'lt_60' THEN 1 WHEN '60_300' THEN 2
        WHEN '300_900' THEN 3 ELSE 4
      END AS bucket_rank,
      CASE seconds_bucket
        WHEN 'lt_60' THEN 30 WHEN '60_300' THEN 180
        WHEN '300_900' THEN 600 ELSE 1200
      END AS representative,
      COUNT(*) AS bucket_count
    FROM reports
    INNER JOIN aggregates USING (slug)
    WHERE status = 'counted' AND reached_human = 1 AND reporter_bucket IS NOT NULL
    GROUP BY slug, seconds_bucket
  ),
  ranked_buckets AS (
    SELECT
      slug,
      bucket_rank,
      representative,
      SUM(bucket_count) OVER (PARTITION BY slug ORDER BY bucket_rank) AS cumulative_count,
      SUM(bucket_count) OVER (PARTITION BY slug) AS total_count
    FROM bucket_counts
  ),
  medians AS (
    SELECT slug, MIN(representative) AS median_seconds
    FROM ranked_buckets
    WHERE cumulative_count * 2 >= total_count
      AND bucket_rank = (
        SELECT MIN(candidate.bucket_rank)
        FROM ranked_buckets AS candidate
        WHERE candidate.slug = ranked_buckets.slug
          AND candidate.cumulative_count * 2 >= candidate.total_count
      )
    GROUP BY slug
  )
  INSERT INTO route_stats
    (slug, up, down, last_confirmed_day, median_seconds, sample_count, updated_at)
  SELECT
    aggregates.slug,
    aggregates.up,
    aggregates.down,
    aggregates.last_confirmed_day,
    medians.median_seconds,
    aggregates.sample_count,
    datetime('now')
  FROM aggregates
  LEFT JOIN medians ON medians.slug = aggregates.slug
  WHERE true
  ON CONFLICT(slug) DO UPDATE SET
    up = excluded.up,
    down = excluded.down,
    last_confirmed_day = excluded.last_confirmed_day,
    median_seconds = excluded.median_seconds,
    sample_count = excluded.sample_count,
    updated_at = excluded.updated_at
`;

export async function recomputeAndPrune(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare(`
      DELETE FROM reports
      WHERE day <= date('now', '-30 days')
    `),
    db.prepare(`DELETE FROM report_rate_limits WHERE expires_at < unixepoch('now')`),
    db.prepare(`DELETE FROM route_stats`),
    db.prepare(RECOMPUTE_ALL_STATS_SQL),
  ]);
}
