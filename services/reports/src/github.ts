import type { AlternatePhoneCandidate } from './store';
import type { Env, RouteStats } from './types';

const encoder = new TextEncoder();

interface GitHubContext {
  repository: string;
  token: string;
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function derLength(length: number): Uint8Array {
  if (length < 128) return Uint8Array.of(length);
  const bytes: number[] = [];
  for (let value = length; value > 0; value >>>= 8) bytes.unshift(value & 0xff);
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

function concatenate(...parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function wrapPkcs1AsPkcs8(pkcs1: Uint8Array): Uint8Array {
  const version = Uint8Array.of(0x02, 0x01, 0x00);
  const rsaAlgorithm = Uint8Array.of(
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
  );
  const privateKey = concatenate(Uint8Array.of(0x04), derLength(pkcs1.length), pkcs1);
  const body = concatenate(version, rsaAlgorithm, privateKey);
  return concatenate(Uint8Array.of(0x30), derLength(body.length), body);
}

function pemBytes(pem: string): Uint8Array {
  const normalized = pem.replaceAll('\\n', '\n');
  const isPkcs1 = normalized.includes('-----BEGIN RSA PRIVATE KEY-----');
  const encoded = normalized
    .replace(/-----BEGIN (?:RSA )?PRIVATE KEY-----|-----END (?:RSA )?PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '');
  const binary = atob(encoded);
  const decoded = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return isPkcs1 ? wrapPkcs1AsPkcs8(decoded) : decoded;
}

async function appJwt(env: Env): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(encoder.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const payload = base64Url(encoder.encode(JSON.stringify({ iat: now - 60, exp: now + 540, iss: env.GITHUB_APP_ID })));
  const unsigned = `${header}.${payload}`;
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemBytes(env.GITHUB_APP_PRIVATE_KEY),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, encoder.encode(unsigned)));
  return `${unsigned}.${base64Url(signature)}`;
}

async function installationToken(env: Env): Promise<string> {
  const response = await fetch(`https://api.github.com/app/installations/${env.GITHUB_INSTALLATION_ID}/access_tokens`, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${await appJwt(env)}`,
      'User-Agent': 'humanplease-reports-worker',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!response.ok) throw new Error(`github_installation_token_${response.status}`);
  const body = (await response.json()) as { token?: string };
  if (!body.token) throw new Error('github_installation_token_missing');
  return body.token;
}

async function github<T>(context: GitHubContext, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${context.token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'humanplease-reports-worker',
      'X-GitHub-Api-Version': '2022-11-28',
      ...init.headers,
    },
  });
  if (!response.ok) throw new Error(`github_api_${response.status}_${path.split('?')[0]}`);
  return (response.status === 204 ? undefined : await response.json()) as T;
}

async function githubOrNull<T>(context: GitHubContext, path: string): Promise<T | null> {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${context.token}`,
      'User-Agent': 'humanplease-reports-worker',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`github_api_${response.status}_${path.split('?')[0]}`);
  return (await response.json()) as T;
}

async function gitBlobSha(content: Uint8Array): Promise<string> {
  const prefix = encoder.encode(`blob ${content.length}\u0000`);
  const blob = new Uint8Array(prefix.length + content.length);
  blob.set(prefix);
  blob.set(content, prefix.length);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', blob));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

interface ReferenceResponse {
  object: { sha: string };
}

interface ContentResponse {
  sha: string;
}

interface PullResponse {
  number: number;
}

async function ensureStatsBranch(
  context: GitHubContext,
  baseBranch: string,
  branch: string,
  hasOpenPull: boolean,
): Promise<void> {
  const base = await github<ReferenceResponse>(context, `/repos/${context.repository}/git/ref/heads/${baseBranch}`);
  const branchPath = `/repos/${context.repository}/git/refs/heads/${branch}`;
  const existing = await githubOrNull<ReferenceResponse>(context, `/repos/${context.repository}/git/ref/heads/${branch}`);
  if (!existing) {
    await github(context, `/repos/${context.repository}/git/refs`, {
      method: 'POST',
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: base.object.sha }),
    });
  } else if (!hasOpenPull) {
    await github(context, branchPath, {
      method: 'PATCH',
      body: JSON.stringify({ sha: base.object.sha, force: true }),
    });
  }
}

export async function publishRouteStats(env: Env, stats: RouteStats[]): Promise<void> {
  if (!env.GITHUB_APP_ID || !env.GITHUB_INSTALLATION_ID || !env.GITHUB_APP_PRIVATE_KEY) {
    throw new Error('github_app_secrets_missing');
  }
  if (!/^[^/]+\/[^/]+$/.test(env.GITHUB_REPOSITORY)) throw new Error('github_repository_invalid');
  const context = { repository: env.GITHUB_REPOSITORY, token: await installationToken(env) };
  const [owner] = env.GITHUB_REPOSITORY.split('/');
  const branch = 'humanplease/route-stats';
  const pulls = await github<PullResponse[]>(
    context,
    `/repos/${context.repository}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}&base=${encodeURIComponent(env.GITHUB_BASE_BRANCH)}`,
  );
  const openPull = pulls[0] ?? null;
  await ensureStatsBranch(context, env.GITHUB_BASE_BRANCH, branch, Boolean(openPull));

  const serializedStats = stats.length
    ? `[\n${stats.map((entry) => JSON.stringify(entry)).join(',\n')}\n]\n`
    : '[]\n';
  const content = encoder.encode(serializedStats);
  const path = 'data/route_stats.json';
  const current = await githubOrNull<ContentResponse>(
    context,
    `/repos/${context.repository}/contents/${path}?ref=${encodeURIComponent(branch)}`,
  );
  let changed = current?.sha !== (await gitBlobSha(content));
  if (changed) {
    await github(context, `/repos/${context.repository}/contents/${path}`, {
      method: 'PUT',
      body: JSON.stringify({
        message: 'Update phone route community stats',
        content: base64(content),
        branch,
        ...(current ? { sha: current.sha } : {}),
      }),
    });
  }

  if (openPull) {
    await github(context, `/repos/${context.repository}/pulls/${openPull.number}`, {
      method: 'PATCH',
      body: JSON.stringify({
        title: 'Update phone route community stats',
        body: 'Updates the reviewed phone-route counters generated by the nightly reports job.',
      }),
    });
  } else if (changed) {
    await github(context, `/repos/${context.repository}/pulls`, {
      method: 'POST',
      body: JSON.stringify({
        title: 'Update phone route community stats',
        head: branch,
        base: env.GITHUB_BASE_BRANCH,
        body: 'Updates the reviewed phone-route counters generated by the nightly reports job.',
      }),
    });
  }
}

function reviewMarker(candidate: AlternatePhoneCandidate): string {
  return `humanplease-phone-review-v1:${candidate.slug}:${candidate.altPhone}`;
}

export async function openAlternatePhoneIssues(env: Env, candidates: AlternatePhoneCandidate[]): Promise<void> {
  if (!candidates.length) return;
  const context = { repository: env.GITHUB_REPOSITORY, token: await installationToken(env) };
  for (const candidate of candidates) {
    const marker = reviewMarker(candidate);
    const query = encodeURIComponent(`repo:${context.repository} is:issue in:body \"${marker}\"`);
    const existing = await github<{ total_count: number }>(context, `/search/issues?q=${query}&per_page=1`);
    if (existing.total_count > 0) continue;
    const route = JSON.stringify({ schemaVersion: 1, slug: candidate.slug, altPhone: candidate.altPhone }, null, 2);
    const body = [
      `<!-- ${marker} -->`,
      '### Route JSON',
      '',
      '```json',
      route,
      '```',
      '',
      '### Privacy check',
      '',
      '- [x] This contains only the route and no transcript, form value, personal information, or secret.',
      '',
      `${candidate.reporterCount} distinct recent report buckets submitted this alternate number. Verify it before changing a published route.`,
    ].join('\n');
    await github(context, `/repos/${context.repository}/issues`, {
      method: 'POST',
      body: JSON.stringify({
        title: `[phone review] ${candidate.slug}: ${candidate.altPhone}`,
        body,
      }),
    });
  }
}
