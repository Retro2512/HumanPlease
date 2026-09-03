import { openAlternatePhoneIssues, publishRouteStats } from './github';
import { loadSlugManifest } from './manifest';
import { alternatePhoneCandidates, readAllStats, recomputeAndPrune } from './store';
import type { Env, RouteStats } from './types';

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

export async function runPromotion(env: Env): Promise<void> {
  await recomputeAndPrune(env.DB);
  const [manifest, storedStats, candidates] = await Promise.all([
    loadSlugManifest(env.REPORTS_KV),
    readAllStats(env.DB),
    alternatePhoneCandidates(env.DB),
  ]);
  const statsBySlug = new Map(storedStats.map((stats) => [stats.slug, stats]));
  const routeStats = manifest.ordered.map((slug) => statsBySlug.get(slug) ?? emptyStats(slug));
  await publishRouteStats(env, routeStats);
  await openAlternatePhoneIssues(env, candidates);
}
