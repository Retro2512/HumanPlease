import type { Env, PhoneReport } from './types';

const encoder = new TextEncoder();
const MAX_REPORTS_PER_HOUR = 10;

function ipv4Bytes(value: string): number[] | null {
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  const bytes: number[] = [];
  for (const part of parts) {
    if (!/^(?:0|[1-9][0-9]{0,2})$/.test(part)) return null;
    const byte = Number(part);
    if (byte > 255) return null;
    bytes.push(byte);
  }
  return bytes;
}

function ipv6Words(value: string): number[] | null {
  let address = value.toLowerCase();
  if (!address.includes(':') || address.includes('%')) return null;
  if (address.includes('.')) {
    const separator = address.lastIndexOf(':');
    const bytes = ipv4Bytes(address.slice(separator + 1));
    if (separator < 0 || !bytes) return null;
    address = `${address.slice(0, separator)}:${((bytes[0] << 8) | bytes[1]).toString(16)}:${((bytes[2] << 8) | bytes[3]).toString(16)}`;
  }
  const halves = address.split('::');
  if (halves.length > 2) return null;
  const parseHalf = (half: string) => half ? half.split(':') : [];
  const left = parseHalf(halves[0]);
  const right = halves.length === 2 ? parseHalf(halves[1]) : [];
  if ([...left, ...right].some((word) => !/^[0-9a-f]{1,4}$/.test(word))) return null;
  if (halves.length === 1 && left.length !== 8) return null;
  if (halves.length === 2 && left.length + right.length >= 8) return null;
  const missing = halves.length === 2 ? 8 - left.length - right.length : 0;
  return [...left, ...Array(missing).fill('0'), ...right].map((word) => Number.parseInt(word, 16));
}

export function clientNetwork(value: string): string | null {
  const ipv4 = ipv4Bytes(value);
  if (ipv4) return ipv4.join('.');
  const words = ipv6Words(value);
  if (!words) return null;
  const isMapped = words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff;
  const isCompatible = words.slice(0, 6).every((word) => word === 0);
  if (isMapped || isCompatible) {
    return [words[6] >>> 8, words[6] & 0xff, words[7] >>> 8, words[7] & 0xff].join('.');
  }
  return `${words.slice(0, 4).map((word) => word.toString(16).padStart(4, '0')).join(':')}::/64`;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function importHmacKey(key: string | Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    typeof key === 'string' ? encoder.encode(key) : key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

export async function hmacBytes(key: string | Uint8Array, value: string): Promise<Uint8Array> {
  const signature = await crypto.subtle.sign('HMAC', await importHmacKey(key), encoder.encode(value));
  return new Uint8Array(signature);
}

export async function hmacHex(key: string | Uint8Array, value: string): Promise<string> {
  return toHex(await hmacBytes(key, value));
}

export async function ipBucket(secret: string, clientIp: string, slug: string, day: string): Promise<Uint8Array> {
  const dailySalt = await hmacBytes(secret, `humanplease:day:${day}`);
  return (await hmacBytes(dailySalt, `${clientIp}\u0000${slug}`)).slice(0, 16);
}

export async function reporterBucket(secret: string, clientIp: string, day: string): Promise<Uint8Array> {
  const month = Number(day.slice(5, 7));
  const quarter = `${day.slice(0, 4)}-Q${Math.floor((month - 1) / 3) + 1}`;
  const rotatingSalt = await hmacBytes(secret, `humanplease:reporter:${quarter}`);
  return (await hmacBytes(rotatingSalt, clientIp)).slice(0, 16);
}

export async function reportDigest(report: PhoneReport): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify(report)));
  return toHex(new Uint8Array(digest));
}

export async function nonceKey(secret: string, clientIp: string, nonce: string): Promise<string> {
  return `nonce:${await hmacHex(secret, `humanplease:nonce:${clientIp}\u0000${nonce}`)}`;
}

export async function enforceRateLimit(env: Env, clientIp: string, now = new Date()): Promise<boolean> {
  if (!env.IP_HASH_SECRET || env.IP_HASH_SECRET.length < 32) throw new Error('rate_limit_secret_invalid');
  const key = `rate:${await hmacHex(env.IP_HASH_SECRET, `humanplease:rate:${clientIp}`)}`;
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const expiresAt = nowSeconds + 3_600;
  const row = await env.DB.prepare(`
    INSERT INTO report_rate_limits (rate_key, request_count, expires_at)
    VALUES (?1, 1, ?2)
    ON CONFLICT(rate_key) DO UPDATE SET
      request_count = CASE
        WHEN report_rate_limits.expires_at <= ?3 THEN 1
        ELSE report_rate_limits.request_count + 1
      END,
      expires_at = CASE
        WHEN report_rate_limits.expires_at <= ?3 THEN excluded.expires_at
        ELSE report_rate_limits.expires_at
      END
    WHERE report_rate_limits.expires_at <= ?3
      OR report_rate_limits.request_count < ${MAX_REPORTS_PER_HOUR}
    RETURNING request_count
  `).bind(key, expiresAt, nowSeconds).first<{ request_count: number }>();
  return Number(row?.request_count ?? MAX_REPORTS_PER_HOUR + 1) <= MAX_REPORTS_PER_HOUR;
}

export async function verifyTurnstile(
  secret: string,
  token: string,
  clientIp: string,
  expectedOrigin: string,
): Promise<boolean> {
  if (!secret || !token || token.length > 4_096) return false;
  const body = new URLSearchParams({ secret, response: token, remoteip: clientIp });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body,
      signal: controller.signal,
    });
    if (!response.ok) return false;
    const result = (await response.json()) as { success?: boolean; hostname?: string; action?: string };
    const expectedHostname = new URL(expectedOrigin).hostname;
    return result.success === true && result.hostname === expectedHostname && result.action === 'phone-report';
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}
