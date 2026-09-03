import type { Env, PhoneReport } from './types';

const encoder = new TextEncoder();

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

export async function reportDigest(report: PhoneReport): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify(report)));
  return toHex(new Uint8Array(digest));
}

export async function nonceKey(secret: string, nonce: string): Promise<string> {
  return `nonce:${await hmacHex(secret, `humanplease:nonce:${nonce}`)}`;
}

export async function enforceRateLimit(env: Env, clientIp: string, now = new Date()): Promise<boolean> {
  const hour = now.toISOString().slice(0, 13);
  const key = `rate:${await hmacHex(env.IP_HASH_SECRET, `humanplease:rate:${hour}:${clientIp}`)}`;
  const current = Number(await env.REPORTS_KV.get(key)) || 0;
  if (current >= 30) return false;
  await env.REPORTS_KV.put(key, String(current + 1), { expirationTtl: 3700 });
  return true;
}

export async function verifyTurnstile(secret: string, token: string, clientIp: string): Promise<boolean> {
  if (!secret || !token) return false;
  const body = new URLSearchParams({ secret, response: token, remoteip: clientIp });
  try {
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body,
    });
    if (!response.ok) return false;
    const result = (await response.json()) as { success?: boolean };
    return result.success === true;
  } catch {
    return false;
  }
}
