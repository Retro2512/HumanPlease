import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const ROOT_KEYS = new Set([
  'schemaVersion',
  'site',
  'locale',
  'startPath',
  'steps',
  'verifiedOn',
]);
const LABELED_ACTIONS = new Set(['open_chat', 'select', 'fill_required']);
const ALL_ACTIONS = new Set([...LABELED_ACTIONS, 'send', 'wait_for_human']);
const HANDOFF_WORDS = /\b(agent|associate|advisor|human|person|representative|customer service|live support)\b/i;
const CASE_DETAIL_WORDS = /\b(my name|i am|i'm|order|account|address|email|phone|booking|case|ticket|reference|confirmation|card)\b/i;
const HOST_RE = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const LOCALE_RE = /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-(?:[A-Z]{2}|[0-9]{3}))?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const UNSAFE_PATTERNS = [
  { name: 'email address', re: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i },
  { name: 'phone number', re: /(?:\+?\d[\s().-]*){8,}/ },
  { name: 'long number', re: /\b\d{7,}\b/ },
  { name: 'UUID', re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i },
  { name: 'IP address', re: /\b(?:\d{1,3}\.){3}\d{1,3}\b/ },
  { name: 'web address', re: /\bhttps?:\/\//i },
  { name: 'secret or credential', re: /\b(?:api[_ -]?key|authorization|bearer|password|passwd|secret|token|cookie|session[_ -]?id)\b/i },
  { name: 'private key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function scanString(value, location, errors) {
  for (const pattern of UNSAFE_PATTERNS) {
    if (pattern.re.test(value)) errors.push(`${location} looks like it contains a ${pattern.name}`);
  }
}

function checkExactKeys(value, allowed, location, errors) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`${location} contains unsupported field "${key}"`);
  }
}

export function validateRoute(value) {
  const errors = [];
  if (!plainObject(value)) return ['route must be a JSON object'];

  checkExactKeys(value, ROOT_KEYS, 'route', errors);
  if (value.schemaVersion !== 1) errors.push('schemaVersion must be 1');

  if (typeof value.site !== 'string' || !HOST_RE.test(value.site)) {
    errors.push('site must be a lowercase hostname such as support.example.com');
  }
  if (typeof value.locale !== 'string' || !LOCALE_RE.test(value.locale)) {
    errors.push('locale must be a language tag such as en or en-CA');
  }
  if (
    typeof value.startPath !== 'string' ||
    !value.startPath.startsWith('/') ||
    value.startPath.length > 240 ||
    /[?#]/.test(value.startPath)
  ) {
    errors.push('startPath must be a URL pathname without a query or fragment');
  }
  if (typeof value.startPath === 'string') {
    scanString(value.startPath, 'startPath', errors);
    if (/\/(?:\d{5,}|[A-Za-z0-9_-]{24,})(?:\/|$)/.test(value.startPath)) {
      errors.push('startPath appears to contain a user-specific identifier');
    }
  }

  if (!Array.isArray(value.steps) || value.steps.length < 1 || value.steps.length > 30) {
    errors.push('steps must contain between 1 and 30 actions');
  } else {
    let waitCount = 0;
    for (const [index, step] of value.steps.entries()) {
      const location = `steps[${index}]`;
      if (!plainObject(step)) {
        errors.push(`${location} must be an object`);
        continue;
      }
      if (!ALL_ACTIONS.has(step.action)) {
        errors.push(`${location}.action is not supported`);
        continue;
      }
      if (LABELED_ACTIONS.has(step.action)) {
        checkExactKeys(step, new Set(['action', 'label']), location, errors);
        if (typeof step.label !== 'string' || step.label.trim().length < 1 || step.label.length > 120) {
          errors.push(`${location}.label must contain 1 to 120 characters`);
        } else {
          scanString(step.label, `${location}.label`, errors);
        }
      } else if (step.action === 'send') {
        checkExactKeys(step, new Set(['action', 'value']), location, errors);
        if (typeof step.value !== 'string' || step.value.trim().length < 1 || step.value.length > 80) {
          errors.push(`${location}.value must contain 1 to 80 characters`);
        } else {
          scanString(step.value, `${location}.value`, errors);
          if (!HANDOFF_WORDS.test(step.value)) {
            errors.push(`${location}.value must be a generic request for a human associate`);
          }
          if (CASE_DETAIL_WORDS.test(step.value)) {
            errors.push(`${location}.value appears to contain case or identity details`);
          }
        }
      } else {
        checkExactKeys(step, new Set(['action']), location, errors);
        waitCount += 1;
        if (index !== value.steps.length - 1) errors.push('wait_for_human must be the final step');
      }
    }
    if (waitCount !== 1) errors.push('steps must end with exactly one wait_for_human action');
  }

  if (typeof value.verifiedOn !== 'string' || !DATE_RE.test(value.verifiedOn)) {
    errors.push('verifiedOn must use YYYY-MM-DD');
  } else {
    const timestamp = Date.parse(`${value.verifiedOn}T00:00:00Z`);
    if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value.verifiedOn) {
      errors.push('verifiedOn is not a real calendar date');
    }
    if (timestamp > Date.now() + 24 * 60 * 60 * 1000) errors.push('verifiedOn cannot be in the future');
  }

  return [...new Set(errors)];
}

export function normalizeRoute(value) {
  return {
    schemaVersion: 1,
    site: value.site.trim().toLowerCase(),
    locale: value.locale.trim(),
    startPath: value.startPath.trim(),
    steps: value.steps.map((step) => {
      if (step.action === 'send') return { action: 'send', value: step.value.trim() };
      if (step.action === 'wait_for_human') return { action: 'wait_for_human' };
      return { action: step.action, label: step.label.trim() };
    }),
    verifiedOn: value.verifiedOn,
  };
}

export function routeFingerprint(route) {
  const identity = {
    schemaVersion: route.schemaVersion,
    site: route.site,
    locale: route.locale,
    startPath: route.startPath,
    steps: route.steps,
  };
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

export function routeRelativePath(route) {
  return path.posix.join('routes', route.site, route.locale, `${routeFingerprint(route).slice(0, 12)}.json`);
}

export async function findJsonFiles(directory) {
  const found = [];
  async function walk(current) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile() && entry.name.endsWith('.json')) found.push(child);
    }
  }
  await walk(directory);
  return found.sort();
}

export async function readRoute(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

export function catalogFor(routes) {
  return {
    schemaVersion: 1,
    routes: routes
      .map(({ route, relativePath }) => ({
        site: route.site,
        locale: route.locale,
        startPath: route.startPath,
        verifiedOn: route.verifiedOn,
        path: relativePath.replaceAll('\\', '/'),
        id: routeFingerprint(route).slice(0, 12),
      }))
      .sort((a, b) => a.site.localeCompare(b.site) || a.locale.localeCompare(b.locale) || a.id.localeCompare(b.id)),
  };
}
