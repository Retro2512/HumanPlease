import { loadSlugManifest } from './manifest';
import { runPromotion } from './promotion';
import { enforceRateLimit, ipBucket, nonceKey, reportDigest, verifyTurnstile } from './security';
import { readStats, readStatsBatch, writeCountedReport } from './store';
import type { Env } from './types';
import { validatePhoneReport, validateStatsBatch } from './validation';

const MAX_BODY_BYTES = 16_384;

interface CachedReportResponse {
  digest: string;
  body: unknown;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function error(code: string, status: number): Response {
  return json({ error: code }, status);
}

function reject(reasonCode: string, status: number): Response {
  console.warn(JSON.stringify({ event: 'report_rejected', reasonCode }));
  return error(reasonCode, status);
}

function allowedOrigin(origin: string | null, productionOrigin: string): boolean {
  if (origin === null) return true;
  if (origin === productionOrigin) return true;
  try {
    const parsed = new URL(origin);
    return (
      parsed.origin === origin &&
      parsed.protocol === 'http:' &&
      parsed.hostname === 'localhost' &&
      parsed.username === '' &&
      parsed.password === ''
    );
  } catch {
    return false;
  }
}

function addCors(response: Response, request: Request, env: Env): Response {
  const origin = request.headers.get('Origin');
  if (!origin || !allowedOrigin(origin, env.PRODUCTION_ORIGIN)) return response;
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', origin);
  headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type, X-Turnstile-Token');
  headers.set('Access-Control-Max-Age', '86400');
  headers.append('Vary', 'Origin');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function parseBody(request: Request): Promise<unknown> {
  if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) {
    throw new Error('content_type');
  }
  const declaredLength = Number(request.headers.get('Content-Length') ?? 0);
  if (declaredLength > MAX_BODY_BYTES) throw new Error('body_too_large');
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) throw new Error('body_too_large');
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('invalid_json');
  }
}

async function handleReport(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
  let input: unknown;
  try {
    input = await parseBody(request);
  } catch (caught) {
    const code = caught instanceof Error ? caught.message : 'invalid_json';
    return reject(code, code === 'body_too_large' ? 413 : 400);
  }
  const validation = validatePhoneReport(input);
  if (!validation.ok || !validation.value) return reject(validation.reasonCode ?? 'schema_invalid', 400);
  const report = validation.value;

  let manifest: Awaited<ReturnType<typeof loadSlugManifest>>;
  try {
    manifest = await loadSlugManifest(env.REPORTS_KV);
  } catch {
    return reject('manifest_unavailable', 503);
  }
  if (!manifest.slugs.has(report.slug)) return reject('unknown_slug', 404);

  const clientIp = request.headers.get('CF-Connecting-IP');
  if (!clientIp) return reject('client_ip_unavailable', 400);
  if (!env.IP_HASH_SECRET) return reject('service_unavailable', 503);

  const key = await nonceKey(env.IP_HASH_SECRET, report.clientNonce);
  const digest = await reportDigest(report);
  const cached = await env.REPORTS_KV.get<CachedReportResponse>(key, 'json');
  if (cached) {
    if (cached.digest !== digest) return reject('nonce_conflict', 409);
    return json(cached.body, 200);
  }

  let withinLimit: boolean;
  try {
    withinLimit = await enforceRateLimit(env, clientIp);
  } catch {
    return reject('rate_limit_unavailable', 503);
  }
  if (!withinLimit) return reject('rate_limited', 429);

  const turnstileToken = request.headers.get('X-Turnstile-Token') ?? '';
  if (!(await verifyTurnstile(env.TURNSTILE_SECRET, turnstileToken, clientIp))) {
    return reject('turnstile_failed', 403);
  }

  const day = new Date().toISOString().slice(0, 10);
  const bucket = await ipBucket(env.IP_HASH_SECRET, clientIp, report.slug, day);
  let writeResult: { replaced: boolean };
  try {
    writeResult = await writeCountedReport(env.DB, report, bucket, day);
  } catch {
    return reject('storage_unavailable', 503);
  }
  const stats = await readStats(env.DB, report.slug);
  const body = { accepted: true, replaced: writeResult.replaced, stats };
  context.waitUntil(
    env.REPORTS_KV.put(key, JSON.stringify({ digest, body }), { expirationTtl: 86_400 }),
  );
  return json(body, 201);
}

async function handleStatsBatch(request: Request, env: Env): Promise<Response> {
  let input: unknown;
  try {
    input = await parseBody(request);
  } catch (caught) {
    const code = caught instanceof Error ? caught.message : 'invalid_json';
    return error(code, code === 'body_too_large' ? 413 : 400);
  }
  if (!validateStatsBatch(input)) return error('schema_invalid', 400);
  let manifest: Awaited<ReturnType<typeof loadSlugManifest>>;
  try {
    manifest = await loadSlugManifest(env.REPORTS_KV);
  } catch {
    return error('manifest_unavailable', 503);
  }
  if (input.slugs.some((slug) => !manifest.slugs.has(slug))) return error('unknown_slug', 404);
  return json({ stats: await readStatsBatch(env.DB, input.slugs) });
}

async function handleRequest(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
  const origin = request.headers.get('Origin');
  if (origin && !allowedOrigin(origin, env.PRODUCTION_ORIGIN)) return error('origin_not_allowed', 403);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204 });

  const url = new URL(request.url);
  if (request.method === 'GET' && url.pathname === '/healthz') return json({ ok: true });
  if (request.method === 'POST' && url.pathname === '/v1/reports') return handleReport(request, env, context);
  if (request.method === 'POST' && url.pathname === '/v1/stats') return handleStatsBatch(request, env);
  if (request.method === 'GET' && url.pathname.startsWith('/v1/stats/')) {
    let slug: string;
    try {
      slug = decodeURIComponent(url.pathname.slice('/v1/stats/'.length));
    } catch {
      return error('unknown_slug', 404);
    }
    let manifest: Awaited<ReturnType<typeof loadSlugManifest>>;
    try {
      manifest = await loadSlugManifest(env.REPORTS_KV);
    } catch {
      return error('manifest_unavailable', 503);
    }
    if (!manifest.slugs.has(slug)) return error('unknown_slug', 404);
    return json(await readStats(env.DB, slug));
  }
  return error('not_found', 404);
}

export default {
  async fetch(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
    try {
      return addCors(await handleRequest(request, env, context), request, env);
    } catch {
      return addCors(error('internal_error', 500), request, env);
    }
  },

  async scheduled(_controller: ScheduledController, env: Env, _context: ExecutionContext): Promise<void> {
    await runPromotion(env);
  },
};

export { handleRequest };
