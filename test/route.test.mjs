import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RECENT_SAMPLE_WINDOW,
  addTimingSample,
  archiveRelativePath,
  chooseFrontRoute,
  createStoredRoute,
  currentRelativePath,
  normalizeSubmission,
  routeFingerprint,
  timingFor,
  validateStoredRoute,
  validateSubmission,
} from '../scripts/lib/route.mjs';

function validSubmission(overrides = {}) {
  return {
    schemaVersion: 2,
    site: 'shop.example.com',
    locale: 'en-CA',
    startPath: '/support',
    steps: [
      { action: 'open_chat', label: 'Chat with us' },
      { action: 'select', label: 'Something else' },
      { action: 'fill_required', label: 'Email' },
      { action: 'send', value: 'live agent' },
      { action: 'wait_for_human' },
    ],
    verifiedOn: '2026-08-24',
    handoffSeconds: 94,
    ...overrides,
  };
}

function storedWithSamples(submission, samples) {
  return {
    ...createStoredRoute({ ...submission, handoffSeconds: samples[0] }),
    timing: timingFor(samples),
  };
}

test('accepts a timed submission containing only navigation data', () => {
  assert.deepEqual(validateSubmission(validSubmission()), []);
  assert.deepEqual(validateStoredRoute(createStoredRoute(validSubmission())), []);
});

test('rejects private values, URL queries, and invalid timings', () => {
  const route = validSubmission({ startPath: '/support?account=123', handoffSeconds: 0 });
  route.steps[2].label = 'me@example.com';
  const errors = validateSubmission(route).join('\n');
  assert.match(errors, /query or fragment/);
  assert.match(errors, /email address/);
  assert.match(errors, /handoffSeconds/);
});

test('rejects case details in a handoff request', () => {
  const route = validSubmission();
  route.steps[3].value = 'My order 88776655 needs a live agent';
  const errors = validateSubmission(route).join('\n');
  assert.match(errors, /long number/);
  assert.match(errors, /case or identity details/);
});

test('requires a single final handoff wait', () => {
  const route = validSubmission();
  route.steps.push({ action: 'select', label: 'Continue' });
  assert.match(validateSubmission(route).join('\n'), /final step/);
});

test('fingerprint ignores timing and verification date', () => {
  const first = validSubmission();
  const second = validSubmission({ handoffSeconds: 180, verifiedOn: '2026-08-23' });
  assert.equal(routeFingerprint(first), routeFingerprint(second));
});

test('timing score penalizes uncertainty and slow tail results', () => {
  const stable = timingFor([90, 91, 89, 90, 90]);
  const erratic = timingFor([40, 60, 90, 180, 300]);
  assert.equal(stable.medianSeconds, 90);
  assert.equal(erratic.medianSeconds, 90);
  assert.ok(erratic.scoreSeconds > stable.scoreSeconds);
  assert.equal(erratic.p90Seconds, 300);
});

test('a challenger needs three samples before it can replace the front route', () => {
  const current = storedWithSamples(validSubmission({ startPath: '/support' }), [120, 121, 119]);
  const challengerOne = storedWithSamples(validSubmission({ startPath: '/contact' }), [45]);
  assert.equal(chooseFrontRoute([current, challengerOne], current.id).id, current.id);
  const challengerThree = storedWithSamples(validSubmission({ startPath: '/contact' }), [45, 48, 46]);
  assert.equal(chooseFrontRoute([current, challengerThree], current.id).id, challengerThree.id);
});

test('one fast challenger sample does not replace a one-sample front route', () => {
  const current = storedWithSamples(validSubmission({ startPath: '/support' }), [120]);
  const challenger = storedWithSamples(validSubmission({ startPath: '/contact' }), [30]);
  assert.equal(chooseFrontRoute([current, challenger], current.id).id, current.id);
});

test('a proven but slower challenger does not replace an under-sampled front route', () => {
  const current = storedWithSamples(validSubmission({ startPath: '/support' }), [60]);
  const challenger = storedWithSamples(validSubmission({ startPath: '/contact' }), [180, 190, 185]);
  assert.equal(chooseFrontRoute([current, challenger], current.id).id, current.id);
});

test('the comparison uses only the latest forty samples while retaining total count', () => {
  let route = createStoredRoute(validSubmission({ handoffSeconds: 100 }));
  for (let seconds = 101; seconds <= 145; seconds += 1) {
    route = addTimingSample(route, seconds, '2026-08-24');
  }
  assert.equal(route.timing.sampleCount, 46);
  assert.equal(route.timing.samplesSeconds.length, RECENT_SAMPLE_WINDOW);
  assert.equal(route.timing.samplesSeconds[0], 106);
  assert.deepEqual(validateStoredRoute(route), []);
});

test('canonical storage separates the front route from archives', () => {
  const route = createStoredRoute(normalizeSubmission(validSubmission({ site: ' SHOP.EXAMPLE.COM ' })));
  assert.equal(currentRelativePath(route), 'routes/shop.example.com/en-CA/current.json');
  assert.match(archiveRelativePath(route), /^archive\/shop\.example\.com\/en-CA\/[a-f0-9]{12}\.json$/);
});
