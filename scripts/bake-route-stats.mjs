/**
 * Bakes data/route_stats.json into every published route page.
 *
 * The client contract in services/reports/README.md requires reviewed aggregate
 * values to ship in the page payload rather than coming from a live endpoint.
 *
 * Idempotent: an existing "votes" key is replaced, not appended.
 */
import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { assertRouteStats } from './lib/route-stats.mjs';

const SITE = path.join(process.cwd(), 'press-zero', 'company');
const STATS = path.join(process.cwd(), 'data', 'route_stats.json');

const stats = new Map(
  assertRouteStats(JSON.parse(await readFile(STATS, 'utf8'))).map((row) => [
    row.slug,
    {
      up: row.up ?? 0,
      down: row.down ?? 0,
      lastConfirmedDay: row.lastConfirmedDay ?? null,
      medianSeconds: row.medianSeconds ?? null,
      stale: Boolean(row.stale),
    },
  ])
);

const slugs = await readdir(SITE, { withFileTypes: true });
let written = 0;
let missing = 0;

for (const entry of slugs) {
  if (!entry.isDirectory()) continue;
  const file = path.join(SITE, entry.name, 'index.html');

  let html;
  try {
    html = await readFile(file, 'utf8');
  } catch {
    continue;
  }

  const row = stats.get(entry.name);
  if (!row) {
    missing += 1;
    continue;
  }

  const marker = '"slug":"' + entry.name + '"';
  const at = html.indexOf(marker);
  if (at < 0) continue;

  const votes = ',"votes":' + JSON.stringify(row);
  const after = at + marker.length;
  const existing = html.slice(after).startsWith(',"votes":');

  let next;
  if (existing) {
    const end = html.indexOf('}', html.indexOf(',"votes":', after) + 9) + 1;
    next = html.slice(0, after) + votes + html.slice(end);
  } else {
    next = html.slice(0, after) + votes + html.slice(after);
  }

  if (next !== html) {
    await writeFile(file, next);
    written += 1;
  }
}

console.log(`baked ${written} pages; ${missing} slugs absent from route_stats.json`);
