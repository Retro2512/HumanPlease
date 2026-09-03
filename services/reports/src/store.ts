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

const MEDIAN_FOR_SLUG_SQL = `
  SELECT representative
  FROM (
    SELECT
      bucket_rank,
      representative,
      SUM(bucket_count) OVER (ORDER BY bucket_rank) AS cumulative_count,
      SUM(bucket_count) OVER () AS total_count
    FROM (
      SELECT
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
      WHERE slug = ?1 AND status = 'counted' AND reached_human = 1
      GROUP BY seconds_bucket
    ) AS bucket_totals
  ) AS ranked_buckets
  WHERE cumulative_count * 2 >= total_count
  ORDER BY bucket_rank
  LIMIT 1
`;

const UPDATE_ONE_STATS_SQL = `
  UPDATE route_stats
  SET
    up = (SELECT COUNT(*) FROM reports WHERE slug = ?1 AND status = 'counted' AND reached_human = 1),
    down = (SELECT COUNT(*) FROM reports WHERE slug = ?1 AND status = 'counted' AND reached_human = 0),
    last_confirmed_day = (SELECT MAX(day) FROM reports WHERE slug = ?1 AND status = 'counted' AND reached_human = 1),
    median_seconds = (${MEDIAN_FOR_SLUG_SQL}),
    sample_count = (SELECT COUNT(*) FROM reports WHERE slug = ?1 AND status = 'counted' AND reached_human = 1),
    updated_at = datetime('now')
  WHERE slug = ?1
`;

function blob(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export async function writeCountedReport(
  db: D1Database,
  report: PhoneReport,
  bucket: Uint8Array,
  day: string,
): Promise<{ replaced: boolean }> {
  const ip = blob(bucket);
  const results = await db.batch([
    db.prepare(`
      UPDATE reports SET status = 'rejected'
      WHERE slug = ?1 AND day = ?2 AND ip_bucket = ?3 AND status = 'counted'
    `).bind(report.slug, day, ip),
    db.prepare(`
      INSERT INTO reports
        (slug, reached_human, seconds_bucket, steps_json, alt_phone, day, ip_bucket, status)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'counted')
    `).bind(
      report.slug,
      report.reachedHuman ? 1 : 0,
      report.secondsBucket,
      report.steps ? JSON.stringify(report.steps) : null,
      report.altPhone ?? null,
      day,
      ip,
    ),
    db.prepare(`
      INSERT INTO route_stats
        (slug, up, down, last_confirmed_day, median_seconds, sample_count, updated_at)
      VALUES (?1, 0, 0, NULL, NULL, 0, datetime('now'))
      ON CONFLICT(slug) DO NOTHING
    `).bind(report.slug),
    db.prepare(UPDATE_ONE_STATS_SQL).bind(report.slug),
  ]);
  return { replaced: Number(results[0]?.meta?.changes ?? 0) > 0 };
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

function emptyStats(slug: string): RouteStats {
  return {
    slug,
    up: 0,
    down: 0,
    lastConfirmedDay: null,
    medianSeconds: null,
    sampleCount: 0,
    stale: false,
  };
}

function statsQuery(whereClause: string): string {
  return `
    WITH recent AS (
      SELECT slug, reached_human
      FROM (
        SELECT
          slug,
          reached_human,
          ROW_NUMBER() OVER (PARTITION BY slug ORDER BY id DESC) AS report_position
        FROM reports
        WHERE status = 'counted'
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

export async function readStats(db: D1Database, slug: string): Promise<RouteStats> {
  const row = await db.prepare(statsQuery('WHERE stats.slug = ?1')).bind(slug).first<StatsRow>();
  return row ? rowToStats(row) : emptyStats(slug);
}

export async function readStatsBatch(db: D1Database, slugs: string[]): Promise<RouteStats[]> {
  if (!slugs.length) return [];
  const placeholders = slugs.map((_, index) => `?${index + 1}`).join(', ');
  const result = await db.prepare(statsQuery(`WHERE stats.slug IN (${placeholders})`)).bind(...slugs).all<StatsRow>();
  const rows = new Map(result.results.map((row) => [row.slug, rowToStats(row)]));
  return slugs.map((slug) => rows.get(slug) ?? emptyStats(slug));
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
    WHERE status = 'counted'
    GROUP BY slug
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
    WHERE status = 'counted' AND reached_human = 1
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
      UPDATE reports
      SET ip_bucket = NULL
      WHERE ip_bucket IS NOT NULL AND day < date('now', '-30 days')
    `),
    db.prepare(RECOMPUTE_ALL_STATS_SQL),
  ]);
}

export interface AlternatePhoneCandidate {
  slug: string;
  altPhone: string;
  reporterCount: number;
}

export async function alternatePhoneCandidates(db: D1Database): Promise<AlternatePhoneCandidate[]> {
  const result = await db.prepare(`
    SELECT
      slug,
      alt_phone AS altPhone,
      COUNT(DISTINCT hex(ip_bucket)) AS reporterCount
    FROM reports
    WHERE status = 'counted' AND alt_phone IS NOT NULL AND ip_bucket IS NOT NULL
    GROUP BY slug, alt_phone
    HAVING COUNT(DISTINCT hex(ip_bucket)) >= 3
    ORDER BY slug, alt_phone
    LIMIT 25
  `).all<AlternatePhoneCandidate>();
  return result.results.map((row) => ({ ...row, reporterCount: Number(row.reporterCount) }));
}
