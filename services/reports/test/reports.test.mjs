import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import worker from '../src/index.ts';
import { clientNetwork, enforceRateLimit, reporterBucket, reportDigest, verifyTurnstile } from '../src/security.ts';
import { RECOMPUTE_ALL_STATS_SQL, writeCountedReport } from '../src/store.ts';
import { validatePhoneReport } from '../src/validation.ts';

const schema = JSON.parse(
  await readFile(new URL('../../../schema/phone-report.schema.json', import.meta.url), 'utf8'),
);
const validateSchema = new Ajv2020({ allErrors: true, strict: true }).compile(schema);

function validReport(overrides = {}) {
  return {
    schemaVersion: 1,
    slug: 'best-buy-ca',
    reachedHuman: true,
    secondsBucket: '60_300',
    stepsMatched: true,
    clientNonce: 'b1c2d3e4f5g6h7i8',
    ...overrides,
  };
}

function schemaAccepts(value) {
  return validateSchema(value) === true;
}

const allowingEdgeLimiter = { async limit() { return { success: true }; } };

test('phone report schema accepts each duration bucket and rejects raw duration data', () => {
  for (const secondsBucket of ['lt_60', '60_300', '300_900', 'gt_900']) {
    assert.equal(schemaAccepts(validReport({ secondsBucket })), true);
  }
  assert.equal(schemaAccepts(validReport({ secondsBucket: 190 })), false);
  assert.equal(schemaAccepts(validReport({ seconds: 190 })), false);
  assert.equal(schemaAccepts(validReport({ timestamp: '2026-09-03T12:00:00Z' })), false);
  assert.equal(schemaAccepts(validReport({ timezone: 'America/Toronto' })), false);
});

test('phone report schema enforces version, slug, required fields, and opaque nonce', () => {
  assert.equal(schemaAccepts(validReport()), true);
  assert.equal(schemaAccepts(validReport({ schemaVersion: 2 })), false);
  assert.equal(schemaAccepts(validReport({ slug: 'Best Buy' })), false);
  assert.equal(schemaAccepts(validReport({ slug: `a${'-b'.repeat(41)}` })), false);
  assert.equal(schemaAccepts(validReport({ clientNonce: 'short' })), false);
  const missing = validReport();
  delete missing.reachedHuman;
  assert.equal(schemaAccepts(missing), false);
});

test('phone report schema accepts only the three keypad step shapes', () => {
  const keys = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '#'];
  const steps = [
    ...keys.map((key) => ({ kind: 'press', key })),
  ];
  assert.equal(schemaAccepts(validReport({ stepsMatched: false, steps })), true);
  assert.equal(schemaAccepts(validReport({ stepsMatched: false, steps: [{ kind: 'say' }, { kind: 'wait' }] })), true);
  assert.equal(schemaAccepts(validReport({ stepsMatched: false, steps: [...steps, { kind: 'wait' }] })), false);
  assert.equal(schemaAccepts(validReport({ stepsMatched: false, steps: [{ kind: 'press', key: 'A' }] })), false);
  assert.equal(schemaAccepts(validReport({ stepsMatched: false, steps: [{ kind: 'say', value: 'billing' }] })), false);
  assert.equal(schemaAccepts(validReport({ stepsMatched: false, steps: [{ kind: 'wait', seconds: 10 }] })), false);
});

test('steps are rejected unless stepsMatched is explicitly false', () => {
  assert.equal(schemaAccepts(validReport({ stepsMatched: true, steps: [{ kind: 'wait' }] })), false);
  const report = validReport({ steps: [{ kind: 'wait' }] });
  delete report.stepsMatched;
  assert.equal(schemaAccepts(report), false);
});

test('phone reports cannot contain alternate phone numbers', () => {
  assert.equal(schemaAccepts(validReport({ reachedHuman: false, altPhone: '+18444335778' })), false);
  assert.equal(schemaAccepts(validReport({ reachedHuman: false, phone: '+18444335778' })), false);
});

test('runtime validation rejects phone-number fields before storage', () => {
  assert.deepEqual(validatePhoneReport(validReport({ reachedHuman: false, altPhone: '+18444335778' })), {
    ok: false,
    reasonCode: 'schema_invalid',
  });
});

test('free text and unexpected nested properties have nowhere to enter the report', () => {
  assert.equal(schemaAccepts(validReport({ note: 'Please call me' })), false);
  assert.equal(
    schemaAccepts(validReport({ stepsMatched: false, steps: [{ kind: 'press', key: '2', note: 'billing' }] })),
    false,
  );
});

class FakeStatement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
    this.bindings = [];
  }
  bind(...bindings) {
    this.bindings = bindings;
    return this;
  }
  first() {
    return this.db.first(this);
  }
}

class FakeD1 {
  reports = [];
  stats = new Map();
  rateLimits = new Map();

  prepare(sql) {
    return new FakeStatement(this, sql);
  }

  async batch(statements) {
    const results = [];
    for (const statement of statements) {
      const sql = statement.sql.replace(/\s+/g, ' ').trim();
      let changes = 0;
      if (sql.startsWith("UPDATE reports SET status = 'rejected'")) {
        const [slug, day, ip] = statement.bindings;
        for (const report of this.reports) {
          const legacyDailyMatch = !report.reporter && report.day === day && buffersEqual(report.ip, ip);
          if (report.slug === slug && report.status === 'counted' && legacyDailyMatch) {
            report.status = 'rejected';
            changes += 1;
          }
        }
      } else if (sql.startsWith('INSERT INTO reports')) {
        const [slug, reached, secondsBucket, stepsJson, day, ip, reporter] = statement.bindings;
        const current = this.reports.find((report) =>
          report.slug === slug && report.status === 'counted' && report.reporter && buffersEqual(report.reporter, reporter));
        if (current) {
          Object.assign(current, { reached, secondsBucket, stepsJson, day, ip });
        } else {
          this.reports.push({ slug, reached, secondsBucket, stepsJson, day, ip, reporter, status: 'counted' });
        }
        changes = 1;
      } else if (sql.startsWith('INSERT INTO route_stats')) {
        const [slug] = statement.bindings;
        if (!this.stats.has(slug)) this.stats.set(slug, emptyStatsRow(slug));
      } else if (sql.startsWith('UPDATE route_stats')) {
        this.recompute(statement.bindings[0]);
        changes = 1;
      } else {
        throw new Error(`Unhandled fake SQL: ${sql.slice(0, 80)}`);
      }
      results.push({ success: true, meta: { changes } });
    }
    return results;
  }

  recompute(slug) {
    const counted = this.reports.filter((report) => report.slug === slug && report.status === 'counted');
    const up = counted.filter((report) => report.reached === 1);
    const representatives = { lt_60: 30, '60_300': 180, '300_900': 600, gt_900: 1200 };
    const samples = up.map((report) => representatives[report.secondsBucket]).sort((a, b) => a - b);
    this.stats.set(slug, {
      slug,
      up: up.length,
      down: counted.length - up.length,
      last_confirmed_day: up.length ? up.map((report) => report.day).sort().at(-1) : null,
      median_seconds: samples.length ? samples[Math.floor((samples.length - 1) / 2)] : null,
      sample_count: samples.length,
      stale: counted.length >= 5 && (counted.length - up.length) / counted.length > 0.4 ? 1 : 0,
    });
  }

  async first(statement) {
    if (statement.sql.includes('SELECT 1 AS present')) {
      const [slug, day, ip, reporter] = statement.bindings;
      const found = this.reports.some((report) => {
        const sameReporter = report.reporter && buffersEqual(report.reporter, reporter);
        const legacyDailyMatch = !report.reporter && report.day === day && buffersEqual(report.ip, ip);
        return report.slug === slug && report.status === 'counted' && (sameReporter || legacyDailyMatch);
      });
      return found ? { present: 1 } : null;
    }
    if (statement.sql.includes('INSERT INTO report_rate_limits')) {
      const [key, expiresAt, nowSeconds] = statement.bindings;
      const previous = this.rateLimits.get(key);
      if (previous && previous.expiresAt > nowSeconds && previous.request_count >= 10) return null;
      const expired = !previous || previous.expiresAt <= nowSeconds;
      const request_count = expired ? 1 : previous.request_count + 1;
      this.rateLimits.set(key, { request_count, expiresAt: expired ? expiresAt : previous.expiresAt });
      return { request_count };
    }
    if (!statement.sql.includes('FROM route_stats AS stats')) throw new Error('Unhandled fake first query');
    return this.stats.get(statement.bindings[0]) ?? null;
  }
}

function emptyStatsRow(slug) {
  return { slug, up: 0, down: 0, last_confirmed_day: null, median_seconds: null, sample_count: 0, stale: 0 };
}

function buffersEqual(left, right) {
  return Buffer.from(left).equals(Buffer.from(right));
}

test('the same IP bucket voting twice in one day replaces the vote instead of adding one', async () => {
  const db = new FakeD1();
  const bucket = Uint8Array.from({ length: 16 }, (_, index) => index);
  const reporter = Uint8Array.from({ length: 16 }, (_, index) => 255 - index);
  const up = validReport();
  const down = validReport({ reachedHuman: false, clientNonce: 'z9y8x7w6v5u4t3s2' });

  assert.deepEqual(await writeCountedReport(db, up, bucket, reporter, '2026-09-03'), { replaced: false });
  assert.deepEqual(await writeCountedReport(db, down, bucket, reporter, '2026-09-03'), { replaced: true });
  assert.equal(db.reports.filter((report) => report.status === 'counted').length, 1);
  assert.equal(db.reports.find((report) => report.status === 'counted').reached, 0);
  assert.deepEqual(db.reports.map((report) => report.status), ['counted']);
});

test('repeat reports update one row instead of allowing database amplification', async () => {
  const db = new FakeD1();
  const reporter = Uint8Array.from({ length: 16 }, (_, index) => index + 60);
  for (let index = 0; index < 100; index += 1) {
    const bucket = Uint8Array.from({ length: 16 }, (_, offset) => (offset + index) % 256);
    await writeCountedReport(
      db,
      validReport({ reachedHuman: index % 2 === 0, clientNonce: `nonce_${String(index).padStart(11, '0')}` }),
      bucket,
      reporter,
      '2026-09-03',
    );
  }
  assert.equal(db.reports.length, 1);
  assert.equal(db.reports[0].status, 'counted');
});

test('one reporter replaces their earlier vote across days in the retention window', async () => {
  const db = new FakeD1();
  const reporter = Uint8Array.from({ length: 16 }, (_, index) => index + 30);
  const firstDaily = Uint8Array.from({ length: 16 }, (_, index) => index);
  const secondDaily = Uint8Array.from({ length: 16 }, (_, index) => index + 1);

  await writeCountedReport(db, validReport(), firstDaily, reporter, '2026-09-01');
  const result = await writeCountedReport(
    db,
    validReport({ reachedHuman: false, clientNonce: 'z9y8x7w6v5u4t3s2' }),
    secondDaily,
    reporter,
    '2026-09-03',
  );

  assert.deepEqual(result, { replaced: true });
  assert.equal(db.reports.filter((report) => report.status === 'counted').length, 1);
});

test('reporter buckets rotate quarterly rather than daily', async () => {
  const secret = 'test-secret-with-enough-entropy';
  assert.deepEqual(
    await reporterBucket(secret, '203.0.113.8', '2026-07-01'),
    await reporterBucket(secret, '203.0.113.8', '2026-09-30'),
  );
  assert.notDeepEqual(
    await reporterBucket(secret, '203.0.113.8', '2026-09-30'),
    await reporterBucket(secret, '203.0.113.8', '2026-10-01'),
  );
});

test('client identities canonicalize IPv4 and group IPv6 privacy addresses by /64', () => {
  assert.equal(clientNetwork('203.0.113.008'), null);
  assert.equal(clientNetwork('203.0.113.8'), '203.0.113.8');
  assert.equal(clientNetwork('::ffff:203.0.113.8'), '203.0.113.8');
  assert.equal(clientNetwork('2606:4700:1234:5678::1'), '2606:4700:1234:5678::/64');
  assert.equal(clientNetwork('2606:4700:1234:5678:ffff:ffff:ffff:ffff'), '2606:4700:1234:5678::/64');
  assert.equal(clientNetwork('2606:4700:1234:5679::1'), '2606:4700:1234:5679::/64');
  assert.equal(clientNetwork('2606:4700:1234::5678::1'), null);
});

test('rate limiting uses an atomic database counter', async () => {
  const env = { DB: new FakeD1(), IP_HASH_SECRET: 'test-secret-with-enough-entropy!' };
  const now = new Date('2026-09-03T10:59:50Z');
  for (let index = 0; index < 10; index += 1) {
    assert.equal(await enforceRateLimit(env, '203.0.113.8', now), true);
  }
  assert.equal(await enforceRateLimit(env, '203.0.113.8', now), false);
  assert.equal(await enforceRateLimit(env, '203.0.113.8', new Date('2026-09-03T11:00:01Z')), false);
  for (let index = 0; index < 100; index += 1) {
    assert.equal(await enforceRateLimit(env, '203.0.113.8', now), false);
  }
  assert.equal([...env.DB.rateLimits.values()][0].request_count, 10);
  assert.equal(await enforceRateLimit(env, '203.0.113.8', new Date('2026-09-03T11:59:50Z')), true);
  assert.equal([...env.DB.rateLimits.values()][0].request_count, 1);
});

test('Turnstile validation binds tokens to the production hostname and report action', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({
      success: true,
      hostname: 'humanplease.wiki',
      action: 'phone-report',
    }));
    assert.equal(await verifyTurnstile('secret', 'token', '203.0.113.8', 'https://humanplease.wiki'), true);

    globalThis.fetch = async () => new Response(JSON.stringify({
      success: true,
      hostname: 'attacker.example',
      action: 'phone-report',
    }));
    assert.equal(await verifyTurnstile('secret', 'token', '203.0.113.8', 'https://humanplease.wiki'), false);
    assert.equal(await verifyTurnstile('secret', 'x'.repeat(4097), '203.0.113.8', 'https://humanplease.wiki'), false);

    globalThis.fetch = async () => new Response(JSON.stringify({
      success: true,
      hostname: 'humanplease.wiki',
      action: 'other-form',
    }));
    assert.equal(await verifyTurnstile('secret', 'token', '203.0.113.8', 'https://humanplease.wiki'), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('unreviewed aggregate stats are not exposed by the Worker', async () => {
  const env = {
    PRODUCTION_ORIGIN: 'https://humanplease.wiki',
    REPORTS_KV: { async get() { throw new Error('removed endpoint must not read KV'); } },
    DB: { prepare() { throw new Error('removed endpoint must not read D1'); } },
  };
  const response = await worker.fetch(
    new Request('https://reports.example/v1/stats/best-buy-ca'),
    env,
    { waitUntil() {} },
  );
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: 'not_found' });
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.match(response.headers.get('Content-Security-Policy'), /default-src 'none'/);
});

test('health responses use hardened non-cacheable headers', async () => {
  const env = {
    PRODUCTION_ORIGIN: 'https://humanplease.wiki',
  };
  const response = await worker.fetch(
    new Request('https://reports.example/healthz'),
    env,
    { waitUntil() {} },
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('Cross-Origin-Resource-Policy'), 'same-site');
  assert.equal(response.headers.get('X-Frame-Options'), 'DENY');
});

test('nightly public aggregates require three distinct reporter buckets', () => {
  assert.match(RECOMPUTE_ALL_STATS_SQL, /HAVING COUNT\(DISTINCT hex\(reporter_bucket\)\) >= 3/);
  assert.match(RECOMPUTE_ALL_STATS_SQL, /INNER JOIN aggregates USING \(slug\)/);
});

test('the unused batch stats POST cannot amplify uncached database reads', async () => {
  const env = {
    PRODUCTION_ORIGIN: 'https://humanplease.wiki',
    REPORTS_KV: { async get() { throw new Error('removed endpoint must not read KV'); } },
    DB: { prepare() { throw new Error('removed endpoint must not read D1'); } },
  };
  const response = await worker.fetch(new Request('https://reports.example/v1/stats', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://humanplease.wiki' },
    body: JSON.stringify({ slugs: ['best-buy-ca'] }),
  }), env, { waitUntil() {} });
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: 'not_found' });
});

test('cached nonce replays remain subject to the hourly rate limit', async () => {
  const report = validReport();
  const cachedBody = { accepted: true, replaced: false, stats: { unreviewed: true } };
  const digest = await reportDigest(report);
  const env = {
    PRODUCTION_ORIGIN: 'https://humanplease.wiki',
    IP_HASH_SECRET: 'test-secret-with-enough-entropy!',
    REPORT_RATE_LIMITER: allowingEdgeLimiter,
    DB: new FakeD1(),
    REPORTS_KV: {
      async get(key) {
        if (key === 'manifest:v1') return { schemaVersion: 1, slugs: [report.slug] };
        return { digest, body: cachedBody };
      },
    },
  };
  let requestIndex = 0;
  const makeRequest = () => new Request('https://reports.example/v1/reports', {
    method: 'POST',
    headers: {
      'CF-Connecting-IP': `2606:4700:1234:5678::${(++requestIndex).toString(16)}`,
      'Content-Type': 'application/json',
      Origin: 'https://humanplease.wiki',
    },
    body: JSON.stringify(report),
  });
  for (let index = 0; index < 10; index += 1) {
    const replay = await worker.fetch(makeRequest(), env, { waitUntil() {} });
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), { accepted: true, replaced: false });
  }
  const blocked = await worker.fetch(makeRequest(), env, { waitUntil() {} });
  assert.equal(blocked.status, 429);
  assert.deepEqual(await blocked.json(), { error: 'rate_limited' });
});

test('edge rate limiting stops report work before KV and D1 access', async () => {
  const keys = [];
  const env = {
    PRODUCTION_ORIGIN: 'https://humanplease.wiki',
    IP_HASH_SECRET: 'test-secret-with-enough-entropy!',
    REPORT_RATE_LIMITER: {
      async limit({ key }) {
        keys.push(key);
        return { success: false };
      },
    },
    REPORTS_KV: { async get() { throw new Error('edge rejection must happen before KV'); } },
    DB: { prepare() { throw new Error('edge rejection must happen before D1'); } },
  };
  const response = await worker.fetch(new Request('https://reports.example/v1/reports', {
    method: 'POST',
    headers: {
      'CF-Connecting-IP': '2606:4700:1234:5678::99',
      'Content-Type': 'application/json',
      Origin: 'https://humanplease.wiki',
    },
    body: JSON.stringify(validReport()),
  }), env, { waitUntil() {} });
  assert.equal(response.status, 429);
  assert.deepEqual(await response.json(), { error: 'rate_limited' });
  assert.deepEqual(keys, ['2606:4700:1234:5678::/64']);
});

test('invalid production origin configuration fails closed', async () => {
  const env = {
    PRODUCTION_ORIGIN: 'https://humanplease.wiki/extra',
    REPORTS_KV: { async get() { throw new Error('invalid configuration must fail first'); } },
    DB: { prepare() { throw new Error('invalid configuration must fail first'); } },
  };
  const response = await worker.fetch(
    new Request('https://reports.example/healthz'),
    env,
    { waitUntil() {} },
  );
  assert.equal(response.status, 503);
});

test('production rejects localhost and unrelated browser origins', async () => {
  const env = {
    PRODUCTION_ORIGIN: 'https://humanplease.wiki',
    REPORTS_KV: { async get() { throw new Error('origin must be rejected before storage'); } },
    DB: { prepare() { throw new Error('origin must be rejected before storage'); } },
  };
  for (const origin of ['http://localhost:8123', 'https://attacker.example', 'https://humanplease.wiki.attacker.example']) {
    const response = await worker.fetch(
      new Request('https://reports.example/v1/stats/best-buy-ca', { headers: { Origin: origin } }),
      env,
      { waitUntil() {} },
    );
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
  }
});

test('chunked request bodies are stopped at the byte limit before parsing or storage', async () => {
  const env = {
    PRODUCTION_ORIGIN: 'https://humanplease.wiki',
    REPORTS_KV: { async get() { throw new Error('oversized body must fail before storage'); } },
    DB: { prepare() { throw new Error('oversized body must fail before storage'); } },
  };
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(9_000));
      controller.enqueue(new Uint8Array(9_000));
      controller.close();
    },
  });
  const request = new Request('https://reports.example/v1/reports', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://humanplease.wiki' },
    body,
    duplex: 'half',
  });
  assert.equal(request.headers.has('Content-Length'), false);
  const response = await worker.fetch(request, env, { waitUntil() {} });
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: 'body_too_large' });
});

test('malformed content lengths and invalid UTF-8 fail closed', async () => {
  const env = {
    PRODUCTION_ORIGIN: 'https://humanplease.wiki',
    REPORTS_KV: { async get() { throw new Error('invalid body must fail before storage'); } },
    DB: { prepare() { throw new Error('invalid body must fail before storage'); } },
  };
  const malformedLength = await worker.fetch(new Request('https://reports.example/v1/reports', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': 'not-a-number', Origin: 'https://humanplease.wiki' },
    body: '{}',
  }), env, { waitUntil() {} });
  assert.equal(malformedLength.status, 400);
  assert.deepEqual(await malformedLength.json(), { error: 'content_length' });

  const invalidUtf8 = await worker.fetch(new Request('https://reports.example/v1/reports', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://humanplease.wiki' },
    body: Uint8Array.of(0xc3, 0x28),
  }), env, { waitUntil() {} });
  assert.equal(invalidUtf8.status, 400);
  assert.deepEqual(await invalidUtf8.json(), { error: 'invalid_json' });
});

test('state-changing requests require the exact production Origin', async () => {
  const env = {
    PRODUCTION_ORIGIN: 'https://humanplease.wiki',
    REPORTS_KV: { async get() { throw new Error('originless POST must fail before storage'); } },
    DB: { prepare() { throw new Error('originless POST must fail before storage'); } },
  };
  const response = await worker.fetch(new Request('https://reports.example/v1/reports', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(validReport()),
  }), env, { waitUntil() {} });
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: 'origin_not_allowed' });
});

test('JSON lookalike media types are rejected before parsing', async () => {
  const env = {
    PRODUCTION_ORIGIN: 'https://humanplease.wiki',
    REPORTS_KV: { async get() { throw new Error('wrong media type must fail before storage'); } },
    DB: { prepare() { throw new Error('wrong media type must fail before storage'); } },
  };
  const response = await worker.fetch(new Request('https://reports.example/v1/reports', {
    method: 'POST',
    headers: { 'Content-Type': 'application/jsonp', Origin: 'https://humanplease.wiki' },
    body: JSON.stringify(validReport()),
  }), env, { waitUntil() {} });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'content_type' });
});

test('public report promotion cannot publish alternate numbers or open issues', async () => {
  const [promotionSource, githubSource] = await Promise.all([
    readFile(new URL('../src/promotion.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/github.ts', import.meta.url), 'utf8'),
  ]);
  assert.doesNotMatch(promotionSource, /alternatePhoneCandidates|openAlternatePhoneIssues/);
  assert.doesNotMatch(githubSource, /altPhone|\/issues(?:\?|`|'|")/);
});
