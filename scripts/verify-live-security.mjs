const siteOrigin = secureOrigin(process.env.LIVE_SITE_ORIGIN || 'https://humanplease.wiki');
const workerOrigin = secureOrigin(
  process.env.LIVE_WORKER_ORIGIN || 'https://humanplease-reports.sudhan2512.workers.dev',
);

const failures = [];

function secureOrigin(value) {
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:' || parsed.origin !== value || parsed.username || parsed.password) {
    throw new Error(`live verification target must be an HTTPS origin: ${value}`);
  }
  return parsed.origin;
}

function check(condition, message) {
  if (!condition) failures.push(message);
}

async function request(url, options = {}) {
  return fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10_000), ...options });
}

const site = await request(`${siteOrigin}/`);
check(site.status === 200, `site root returned ${site.status}`);
const csp = site.headers.get('content-security-policy') || '';
for (const directive of [
  "default-src 'self'", "base-uri 'none'", "object-src 'none'", "frame-ancestors 'none'",
  "form-action 'none'", "script-src-attr 'none'", "style-src-attr 'none'", "worker-src 'none'",
]) check(csp.includes(directive), `site CSP is missing ${directive}`);
check(!csp.includes("'unsafe-inline'"), 'site CSP permits unsafe inline code');
check(site.headers.get('x-frame-options') === 'DENY', 'site does not deny framing');
check(site.headers.get('x-content-type-options') === 'nosniff', 'site does not disable MIME sniffing');
check((site.headers.get('strict-transport-security') || '').includes('max-age='), 'site is missing HSTS');
check(Boolean(site.headers.get('permissions-policy')), 'site is missing Permissions-Policy');
check(Boolean(site.headers.get('referrer-policy')), 'site is missing Referrer-Policy');
check(!/\/\d/.test(site.headers.get('server') || ''), 'site exposes a versioned Server header');
check(!site.headers.has('x-powered-by'), 'site exposes X-Powered-By');

const plaintext = await request(siteOrigin.replace(/^https:/, 'http:'));
check(
  [301, 302, 307, 308].includes(plaintext.status) && plaintext.headers.get('location')?.startsWith(siteOrigin),
  `HTTP does not redirect to the HTTPS origin (${plaintext.status})`,
);

const unsafeMethod = await request(`${siteOrigin}/`, { method: 'POST' });
check(unsafeMethod.status === 405, `site accepted POST with status ${unsafeMethod.status}`);

for (const path of ['/.git/config', '/.env', '/services/reports/src/index.ts', '/server-status']) {
  const response = await request(`${siteOrigin}${path}`);
  check(response.status !== 200, `sensitive path is public: ${path}`);
}

const health = await request(`${workerOrigin}/healthz`);
check(health.status === 200, `Worker health returned ${health.status}`);
check(health.headers.get('cache-control') === 'no-store', 'Worker health is cacheable');
check(health.headers.get('content-security-policy') === "default-src 'none'; frame-ancestors 'none'", 'Worker CSP is missing');
check(health.headers.get('x-frame-options') === 'DENY', 'Worker does not deny framing');
check(health.headers.get('x-content-type-options') === 'nosniff', 'Worker does not disable MIME sniffing');
check(!health.headers.has('access-control-allow-origin'), 'Worker health reflects an absent Origin');

const oldStats = await request(`${workerOrigin}/v1/stats/best-buy-ca`);
check(oldStats.status === 404, `removed public stats endpoint returned ${oldStats.status}`);

const hostilePreflight = await request(`${workerOrigin}/v1/report`, {
  method: 'OPTIONS',
  headers: { Origin: 'https://attacker.invalid', 'Access-Control-Request-Method': 'POST' },
});
check(hostilePreflight.status === 403, `hostile preflight returned ${hostilePreflight.status}`);
check(!hostilePreflight.headers.has('access-control-allow-origin'), 'hostile preflight received CORS access');

if (failures.length) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  process.exitCode = 1;
} else {
  console.log('Live security checks passed.');
}
