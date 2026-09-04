import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

export const RECENT_SAMPLE_WINDOW = 40;
export const MIN_PROMOTION_SAMPLES = 3;
export const PROMOTION_MARGIN = 0.03;

const COMMON_KEYS = ['schemaVersion', 'site', 'locale', 'startPath', 'steps', 'verifiedOn'];
const SUBMISSION_KEYS = new Set([...COMMON_KEYS, 'handoffSeconds']);
const STORED_KEYS = new Set([...COMMON_KEYS, 'id', 'timing']);
const TIMING_KEYS = new Set([
  'sampleCount', 'samplesSeconds', 'medianSeconds', 'p90Seconds', 'madSeconds', 'scoreSeconds',
]);
const LABELED_ACTIONS = new Set(['open_chat', 'select', 'fill_required']);
const ALL_ACTIONS = new Set([...LABELED_ACTIONS, 'send', 'wait_for_human']);
const HANDOFF_WORDS = /\b(agent|associate|advisor|human|person|representative|customer service|live support)\b/i;
const CASE_DETAIL_WORDS = /\b(my name|i am|i'm|order|account|address|email|phone|booking|case|ticket|reference|confirmation|card)\b/i;
const HOST_RE = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const LOCALE_RE = /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-(?:[A-Z]{2}|[0-9]{3}))?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ID_RE = /^[a-f0-9]{12}$/;

const UNSAFE_PATTERNS = [
  { name: 'email address', re: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i },
  { name: 'phone number', re: /(?:\+?\d[\s().-]*){8,}/ },
  { name: 'long number', re: /\b\d{7,}\b/ },
  { name: 'UUID', re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i },
  { name: 'IP address', re: /\b(?:\d{1,3}\.){3}\d{1,3}\b/ },
  { name: 'web address', re: /\bhttps?:\/\//i },
  { name: 'secret or credential', re: /\b(?:api[_ -]?key|authorization|bearer|password|passwd|secret|token|cookie|session[_ -]?id)\b/i },
  { name: 'private key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'HTML markup', re: /[<>]/ },
  { name: 'control character', re: /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/ },
];

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function rounded(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function median(sorted) {
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function nearestRank(sorted, percentile) {
  return sorted[Math.max(0, Math.ceil(percentile * sorted.length) - 1)];
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

function validateCommon(value, allowedKeys) {
  const errors = [];
  if (!plainObject(value)) return ['route must be a JSON object'];
  checkExactKeys(value, allowedKeys, 'route', errors);
  if (value.schemaVersion !== 2) errors.push('schemaVersion must be 2');
  if (typeof value.site !== 'string' || !HOST_RE.test(value.site)) {
    errors.push('site must be a lowercase hostname such as support.example.com');
  }
  if (typeof value.locale !== 'string' || !LOCALE_RE.test(value.locale)) {
    errors.push('locale must be a language tag such as en or en-CA');
  }
  if (
    typeof value.startPath !== 'string' || !value.startPath.startsWith('/') || value.startPath.startsWith('//') ||
    value.startPath.length > 240 || /[\\?#]/.test(value.startPath) || /%(?:0d|0a|2f|3f|5c)/i.test(value.startPath)
  ) {
    errors.push('startPath must be a same-origin URL pathname without encoded separators, query or fragment');
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
        } else scanString(step.label, `${location}.label`, errors);
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
    if (timestamp > Date.now() + 86_400_000) errors.push('verifiedOn cannot be in the future');
  }
  return errors;
}

export function timingFor(samplesSeconds, sampleCount = samplesSeconds.length) {
  const sorted = [...samplesSeconds].sort((a, b) => a - b);
  const medianSeconds = rounded(median(sorted));
  const deviations = sorted.map((sample) => Math.abs(sample - medianSeconds)).sort((a, b) => a - b);
  const madSeconds = rounded(median(deviations));
  const p90Seconds = nearestRank(sorted, 0.9);
  const uncertainty = (Math.max(5, 1.4826 * madSeconds) * 1.96) / Math.sqrt(sorted.length);
  const coldStart = 30 / Math.sqrt(sorted.length);
  const tailPenalty = Math.max(0, p90Seconds - medianSeconds) * 0.2;
  return {
    sampleCount,
    samplesSeconds: [...samplesSeconds],
    medianSeconds,
    p90Seconds,
    madSeconds,
    scoreSeconds: Math.round(medianSeconds + uncertainty + coldStart + tailPenalty),
  };
}

export function validateSubmission(value) {
  const errors = validateCommon(value, SUBMISSION_KEYS);
  if (!plainObject(value)) return errors;
  if (!Number.isInteger(value.handoffSeconds) || value.handoffSeconds < 1 || value.handoffSeconds > 14_400) {
    errors.push('handoffSeconds must be a whole number from 1 to 14400');
  }
  return [...new Set(errors)];
}

export function validateStoredRoute(value) {
  const errors = validateCommon(value, STORED_KEYS);
  if (!plainObject(value)) return errors;
  if (typeof value.id !== 'string' || !ID_RE.test(value.id)) errors.push('id must be a 12-character route hash');
  if (typeof value.id === 'string' && value.id !== routeId(value)) errors.push('id does not match the route');
  if (!plainObject(value.timing)) {
    errors.push('timing must be an object');
  } else {
    checkExactKeys(value.timing, TIMING_KEYS, 'timing', errors);
    const { sampleCount, samplesSeconds } = value.timing;
    if (!Number.isInteger(sampleCount) || sampleCount < 1) errors.push('timing.sampleCount must be a positive integer');
    if (
      !Array.isArray(samplesSeconds) || samplesSeconds.length < 1 ||
      samplesSeconds.length > RECENT_SAMPLE_WINDOW ||
      samplesSeconds.some((sample) => !Number.isInteger(sample) || sample < 1 || sample > 14_400)
    ) {
      errors.push(`timing.samplesSeconds must contain 1 to ${RECENT_SAMPLE_WINDOW} valid timings`);
    } else if (Number.isInteger(sampleCount)) {
      if (sampleCount < samplesSeconds.length) errors.push('timing.sampleCount cannot be smaller than the retained sample window');
      const expected = timingFor(samplesSeconds, sampleCount);
      if (JSON.stringify(value.timing) !== JSON.stringify(expected)) {
        errors.push('timing summary does not match timing.samplesSeconds');
      }
    }
  }
  return [...new Set(errors)];
}

export function normalizeSubmission(value) {
  return {
    ...value,
    schemaVersion: value.schemaVersion,
    site: value.site.trim().toLowerCase(),
    locale: value.locale.trim(),
    startPath: value.startPath.trim(),
    steps: value.steps.map((step) => {
      if (step.action === 'send') return { ...step, value: step.value.trim() };
      if (step.action === 'wait_for_human') return { ...step };
      return { ...step, label: step.label.trim() };
    }),
    verifiedOn: value.verifiedOn,
    handoffSeconds: value.handoffSeconds,
  };
}

export function routeFingerprint(route) {
  return createHash('sha256').update(JSON.stringify({
    schemaVersion: 2,
    site: route.site,
    locale: route.locale,
    startPath: route.startPath,
    steps: route.steps,
  })).digest('hex');
}

export function routeId(route) {
  return routeFingerprint(route).slice(0, 12);
}

export function createStoredRoute(submission) {
  return {
    schemaVersion: 2,
    id: routeId(submission),
    site: submission.site,
    locale: submission.locale,
    startPath: submission.startPath,
    steps: submission.steps,
    verifiedOn: submission.verifiedOn,
    timing: timingFor([submission.handoffSeconds]),
  };
}

export function addTimingSample(route, seconds, verifiedOn) {
  const samples = [...route.timing.samplesSeconds, seconds].slice(-RECENT_SAMPLE_WINDOW);
  return {
    ...route,
    verifiedOn: verifiedOn > route.verifiedOn ? verifiedOn : route.verifiedOn,
    timing: timingFor(samples, route.timing.sampleCount + 1),
  };
}

export function currentRelativePath(route) {
  return path.posix.join('routes', route.site, route.locale, 'current.json');
}

export function archiveRelativePath(route) {
  return path.posix.join('archive', route.site, route.locale, `${route.id}.json`);
}

export function chooseFrontRoute(routes, currentId = null) {
  if (!routes.length) return null;
  const current = routes.find((route) => route.id === currentId) ?? null;
  const eligible = routes.filter((route) => route.timing.samplesSeconds.length >= MIN_PROMOTION_SAMPLES);
  const pool = eligible.length ? eligible : routes;
  const best = [...pool].sort((a, b) =>
    a.timing.scoreSeconds - b.timing.scoreSeconds ||
    a.timing.medianSeconds - b.timing.medianSeconds ||
    a.steps.length - b.steps.length || a.id.localeCompare(b.id))[0];
  if (!current) return best;
  if (best.id === current.id) return current;
  if (best.timing.samplesSeconds.length < MIN_PROMOTION_SAMPLES) return current;
  if (best.timing.scoreSeconds <= current.timing.scoreSeconds * (1 - PROMOTION_MARGIN)) return best;
  return current;
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

export async function loadRepositoryRoutes(root) {
  const activeFiles = await findJsonFiles(path.join(root, 'routes'));
  const archiveFiles = (await findJsonFiles(path.join(root, 'archive'))).filter(
    (file) => path.basename(file) !== 'catalog.json',
  );
  const active = await Promise.all(activeFiles.map(async (file) => ({
    route: await readRoute(file), relativePath: path.relative(root, file),
  })));
  const archived = await Promise.all(archiveFiles.map(async (file) => ({
    route: await readRoute(file), relativePath: path.relative(root, file),
  })));
  return { active, archived };
}

export function catalogFor(entries, archived = false) {
  return {
    schemaVersion: 2,
    kind: archived ? 'archive' : 'fastest',
    routes: entries.map(({ route, relativePath }) => ({
      id: route.id,
      site: route.site,
      locale: route.locale,
      startPath: route.startPath,
      verifiedOn: route.verifiedOn,
      medianSeconds: route.timing.medianSeconds,
      p90Seconds: route.timing.p90Seconds,
      scoreSeconds: route.timing.scoreSeconds,
      samples: route.timing.sampleCount,
      path: relativePath.replaceAll('\\', '/'),
    })).sort((a, b) =>
      a.site.localeCompare(b.site) || a.locale.localeCompare(b.locale) || a.id.localeCompare(b.id)),
  };
}
