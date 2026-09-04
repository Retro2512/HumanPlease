import { loadSlugManifest } from './manifest';
import { runPromotion } from './promotion';
import { clientNetwork, enforceRateLimit, ipBucket, nonceKey, reportDigest, reporterBucket, verifyTurnstile } from './security';
import { writeCountedReport } from './store';
import type { Env } from './types';
import { validatePhoneReport } from './validation';

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
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
      'Cross-Origin-Resource-Policy': 'same-site',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function error(code: string, status: number): Response {
  return json({ error: code }, status);
}

function reject(reasonCode: string, status: number): Response {
  if (status >= 500) console.error(JSON.stringify({ event: 'report_failed', reasonCode }));
  return error(reasonCode, status);
}

function allowedOrigin(origin: string | null, productionOrigin: string): boolean {
  if (origin === null) return true;
  return origin === productionOrigin;
}

function validConfiguredOrigin(origin: string): boolean {
  try {
    const parsed = new URL(origin);
    const local = parsed.protocol === 'http:' && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1');
    return parsed.origin === origin && !parsed.username && !parsed.password && (parsed.protocol === 'https:' || local);
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
  const mediaType = request.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase();
  if (mediaType !== 'application/json') {
    throw new Error('content_type');
  }
  const contentLength = request.headers.get('Content-Length');
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength.trim())) throw new Error('content_length');
    if (Number(contentLength) > MAX_BODY_BYTES) throw new Error('body_too_large');
  }

  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_BODY_BYTES) {
        try { await reader.cancel(); } catch { /* the size limit still applies */ }
        throw new Error('body_too_large');
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
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

  const connectingIp = request.headers.get('CF-Connecting-IP');
  if (!connectingIp) return reject('client_ip_unavailable', 400);
  const pseudoIpv4 = /^(?:24[0-9]|25[0-5])\./.test(connectingIp);
  const clientIp = pseudoIpv4 ? request.headers.get('CF-Connecting-IPv6') ?? connectingIp : connectingIp;
  const clientIdentity = clientNetwork(clientIp);
  if (!clientIdentity) return reject('client_ip_invalid', 400);
  if (!env.IP_HASH_SECRET || env.IP_HASH_SECRET.length < 32) return reject('service_unavailable', 503);

  try {
    if (!(await env.REPORT_RATE_LIMITER.limit({ key: clientIdentity })).success) {
      return reject('rate_limited', 429);
    }
  } catch {
    return reject('edge_rate_limit_unavailable', 503);
  }

  let manifest: Awaited<ReturnType<typeof loadSlugManifest>>;
  try {
    manifest = await loadSlugManifest(env.REPORTS_KV);
  } catch {
    return reject('manifest_unavailable', 503);
  }
  if (!manifest.slugs.has(report.slug)) return reject('unknown_slug', 404);

  let withinLimit: boolean;
  try {
    withinLimit = await enforceRateLimit(env, clientIdentity);
  } catch {
    return reject('rate_limit_unavailable', 503);
  }
  if (!withinLimit) return reject('rate_limited', 429);

  const key = await nonceKey(env.IP_HASH_SECRET, clientIdentity, report.clientNonce);
  const digest = await reportDigest(report);
  const cached = await env.REPORTS_KV.get<CachedReportResponse>(key, 'json');
  if (cached) {
    if (cached.digest !== digest) return reject('nonce_conflict', 409);
    const cachedBody = cached.body as { accepted?: unknown; replaced?: unknown } | null;
    if (cachedBody?.accepted !== true || typeof cachedBody.replaced !== 'boolean') {
      return reject('idempotency_unavailable', 503);
    }
    return json({ accepted: true, replaced: cachedBody.replaced }, 200);
  }

  const turnstileToken = request.headers.get('X-Turnstile-Token') ?? '';
  if (!(await verifyTurnstile(env.TURNSTILE_SECRET, turnstileToken, clientIp, env.PRODUCTION_ORIGIN))) {
    return reject('turnstile_failed', 403);
  }

  const day = new Date().toISOString().slice(0, 10);
  const bucket = await ipBucket(env.IP_HASH_SECRET, clientIdentity, report.slug, day);
  const reporter = await reporterBucket(env.IP_HASH_SECRET, clientIdentity, day);
  let writeResult: { replaced: boolean };
  try {
    writeResult = await writeCountedReport(env.DB, report, bucket, reporter, day);
  } catch {
    return reject('storage_unavailable', 503);
  }
  const body = { accepted: true, replaced: writeResult.replaced };
  context.waitUntil(
    env.REPORTS_KV.put(key, JSON.stringify({ digest, body }), { expirationTtl: 86_400 }),
  );
  return json(body, 201);
}

async function handleRequest(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
  if (!validConfiguredOrigin(env.PRODUCTION_ORIGIN)) return error('service_unavailable', 503);
  const origin = request.headers.get('Origin');
  if ((request.method === 'POST' || request.method === 'OPTIONS') && origin !== env.PRODUCTION_ORIGIN) {
    return error('origin_not_allowed', 403);
  }
  if (origin && !allowedOrigin(origin, env.PRODUCTION_ORIGIN)) return error('origin_not_allowed', 403);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204 });

  const url = new URL(request.url);
  if (request.method === 'GET' && url.pathname === '/healthz') return json({ ok: true });
  if (request.method === 'POST' && url.pathname === '/v1/reports') return handleReport(request, env, context);
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
