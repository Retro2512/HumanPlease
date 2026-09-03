import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import worker from '../src/index.ts';
import { readStats, writeCountedReport } from '../src/store.ts';
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

test('alternate numbers require a failed handoff and E.164 length', () => {
  assert.equal(schemaAccepts(validReport({ reachedHuman: false, altPhone: '+18444335778' })), true);
  assert.equal(schemaAccepts(validReport({ reachedHuman: true, altPhone: '+18444335778' })), false);
  assert.equal(schemaAccepts(validReport({ reachedHuman: false, altPhone: '8444335778' })), false);
  assert.equal(schemaAccepts(validReport({ reachedHuman: false, altPhone: '+1234567' })), false);
  assert.equal(schemaAccepts(validReport({ reachedHuman: false, altPhone: '+1234567890123456' })), false);
});

test('runtime validation rejects premium-rate prefixes from the data file', () => {
  assert.deepEqual(validatePhoneReport(validReport({ reachedHuman: false, altPhone: '+18444335778' })).ok, true);
  assert.deepEqual(
    validatePhoneReport(validReport({ reachedHuman: false, altPhone: '+19005551234' })),
    { ok: false, reasonCode: 'phone_rejected' },
  );
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
          if (report.slug === slug && report.day === day && report.status === 'counted' && buffersEqual(report.ip, ip)) {
            report.status = 'rejected';
            changes += 1;
          }
        }
      } else if (sql.startsWith('INSERT INTO reports')) {
        const [slug, reached, secondsBucket, stepsJson, altPhone, day, ip] = statement.bindings;
        this.reports.push({ slug, reached, secondsBucket, stepsJson, altPhone, day, ip, status: 'counted' });
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
  const up = validReport();
  const down = validReport({ reachedHuman: false, clientNonce: 'z9y8x7w6v5u4t3s2' });

  assert.deepEqual(await writeCountedReport(db, up, bucket, '2026-09-03'), { replaced: false });
  assert.deepEqual(await writeCountedReport(db, down, bucket, '2026-09-03'), { replaced: true });
  const stats = await readStats(db, 'best-buy-ca');

  assert.equal(stats.up, 0);
  assert.equal(stats.down, 1);
  assert.equal(stats.up + stats.down, 1);
  assert.deepEqual(db.reports.map((report) => report.status), ['rejected', 'counted']);
});

test('GET stats returns 404 rather than zeros for an unknown slug', async () => {
  const env = {
    PRODUCTION_ORIGIN: 'https://humanplease.wiki',
    REPORTS_KV: {
      async get(key, type) {
        assert.equal(key, 'manifest:v1');
        assert.equal(type, 'json');
        return { schemaVersion: 1, slugs: ['best-buy-ca'] };
      },
    },
    DB: { prepare() { throw new Error('database must not be read for unknown slugs'); } },
  };
  const response = await worker.fetch(
    new Request('https://reports.example/v1/stats/not-a-real-company'),
    env,
    { waitUntil() {} },
  );
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: 'unknown_slug' });
});
