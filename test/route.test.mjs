import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeRoute, routeFingerprint, routeRelativePath, validateRoute } from '../scripts/lib/route.mjs';

function validRoute() {
  return {
    schemaVersion: 1,
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
    verifiedOn: '2026-08-23',
  };
}

test('accepts a route that contains only navigation data', () => {
  assert.deepEqual(validateRoute(validRoute()), []);
});

test('rejects private values and URL queries', () => {
  const route = validRoute();
  route.startPath = '/support?account=123';
  route.steps[2].label = 'me@example.com';
  const errors = validateRoute(route).join('\n');
  assert.match(errors, /query or fragment/);
  assert.match(errors, /email address/);
});

test('rejects case details in a send step', () => {
  const route = validRoute();
  route.steps[3].value = 'Order 88776655 needs a live agent';
  assert.match(validateRoute(route).join('\n'), /long number/);
});

test('rejects a handoff request mixed with identity details', () => {
  const route = validRoute();
  route.steps[3].value = 'My name is Jordan, connect me to a human';
  assert.match(validateRoute(route).join('\n'), /case or identity details/);
});

test('requires a single final handoff wait', () => {
  const route = validRoute();
  route.steps.push({ action: 'select', label: 'Continue' });
  assert.match(validateRoute(route).join('\n'), /final step/);
});

test('fingerprint ignores the verification date', () => {
  const first = validRoute();
  const second = validRoute();
  second.verifiedOn = '2026-08-22';
  assert.equal(routeFingerprint(first), routeFingerprint(second));
});

test('normalization produces the canonical storage path', () => {
  const route = validRoute();
  route.site = ' SHOP.EXAMPLE.COM ';
  const normalized = normalizeRoute(route);
  assert.match(routeRelativePath(normalized), /^routes\/shop\.example\.com\/en-CA\/[a-f0-9]{12}\.json$/);
});
