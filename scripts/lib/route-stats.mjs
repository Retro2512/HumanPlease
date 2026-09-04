const KEYS = new Set([
  'slug', 'up', 'down', 'lastConfirmedDay', 'medianSeconds', 'sampleCount', 'stale',
]);
const SLUG = /^[a-z0-9][a-z0-9-]{0,80}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MEDIANS = new Set([null, 30, 180, 600, 1200]);

function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000;
}

export function assertRouteStats(input) {
  if (!Array.isArray(input) || input.length > 50_000) throw new Error('route stats must be a bounded array');
  const seen = new Set();
  for (const [index, row] of input.entries()) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) throw new Error(`route stats row ${index} is invalid`);
    if (Object.keys(row).length !== KEYS.size || Object.keys(row).some((key) => !KEYS.has(key))) {
      throw new Error(`route stats row ${index} has unsupported fields`);
    }
    if (typeof row.slug !== 'string' || !SLUG.test(row.slug) || seen.has(row.slug)) {
      throw new Error(`route stats row ${index} has an invalid or duplicate slug`);
    }
    seen.add(row.slug);
    if (!safeCount(row.up) || !safeCount(row.down) || !safeCount(row.sampleCount) || row.sampleCount !== row.up) {
      throw new Error(`route stats row ${index} has invalid counts`);
    }
    if (!MEDIANS.has(row.medianSeconds) || typeof row.stale !== 'boolean') {
      throw new Error(`route stats row ${index} has invalid aggregate values`);
    }
    if (row.lastConfirmedDay !== null) {
      if (typeof row.lastConfirmedDay !== 'string' || !DATE.test(row.lastConfirmedDay)) {
        throw new Error(`route stats row ${index} has an invalid date`);
      }
      const parsed = new Date(`${row.lastConfirmedDay}T00:00:00Z`);
      if (
        !Number.isFinite(parsed.getTime()) ||
        parsed.toISOString().slice(0, 10) !== row.lastConfirmedDay ||
        parsed.getTime() > Date.now() + 86_400_000
      ) {
        throw new Error(`route stats row ${index} has an invalid date`);
      }
    }
    if (row.up === 0 && (row.lastConfirmedDay !== null || row.medianSeconds !== null)) {
      throw new Error(`route stats row ${index} has success metadata without successful reports`);
    }
    if (row.up > 0 && (row.lastConfirmedDay === null || row.medianSeconds === null)) {
      throw new Error(`route stats row ${index} is missing success metadata`);
    }
    if (row.stale && (row.up + row.down < 5 || row.down === 0)) {
      throw new Error(`route stats row ${index} has an impossible stale flag`);
    }
  }
  return input;
}
