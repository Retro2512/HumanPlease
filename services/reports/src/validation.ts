import rejectedPhonePrefixes from '../../../data/rejected_phone_prefixes.json';
import { SECONDS_BUCKETS, type PhoneReport, type PhoneStep, type ValidationResult } from './types';

const ROOT_KEYS = new Set([
  'schemaVersion',
  'slug',
  'reachedHuman',
  'secondsBucket',
  'stepsMatched',
  'steps',
  'altPhone',
  'clientNonce',
]);
const PRESS_KEYS = new Set(['kind', 'key']);
const KIND_ONLY_KEYS = new Set(['kind']);
const SLUG = /^[a-z0-9][a-z0-9-]{0,80}$/;
const E164 = /^\+[1-9][0-9]{7,14}$/;
const NONCE = /^[A-Za-z0-9_-]{16,128}$/;
const KEYPAD_KEY = /^[0-9*#]$/;
const buckets = new Set<string>(SECONDS_BUCKETS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isStep(value: unknown): value is PhoneStep {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'press') {
    return hasOnlyKeys(value, PRESS_KEYS) && typeof value.key === 'string' && KEYPAD_KEY.test(value.key);
  }
  if (value.kind === 'say' || value.kind === 'wait') {
    return hasOnlyKeys(value, KIND_ONLY_KEYS);
  }
  return false;
}

export function isRejectedPhone(phone: string): boolean {
  return rejectedPhonePrefixes.prefixes.some((prefix) => phone.startsWith(prefix));
}

export function validatePhoneReport(input: unknown): ValidationResult {
  if (!isRecord(input) || !hasOnlyKeys(input, ROOT_KEYS)) {
    return { ok: false, reasonCode: 'schema_invalid' };
  }
  if (
    input.schemaVersion !== 1 ||
    typeof input.slug !== 'string' ||
    !SLUG.test(input.slug) ||
    typeof input.reachedHuman !== 'boolean' ||
    typeof input.secondsBucket !== 'string' ||
    !buckets.has(input.secondsBucket) ||
    typeof input.stepsMatched !== 'boolean' ||
    typeof input.clientNonce !== 'string' ||
    !NONCE.test(input.clientNonce)
  ) {
    return { ok: false, reasonCode: 'schema_invalid' };
  }
  if ('steps' in input) {
    if (input.stepsMatched !== false || !Array.isArray(input.steps) || input.steps.length > 12 || !input.steps.every(isStep)) {
      return { ok: false, reasonCode: 'schema_invalid' };
    }
  }
  if ('altPhone' in input) {
    if (input.reachedHuman !== false || typeof input.altPhone !== 'string' || !E164.test(input.altPhone)) {
      return { ok: false, reasonCode: 'schema_invalid' };
    }
    if (isRejectedPhone(input.altPhone)) {
      return { ok: false, reasonCode: 'phone_rejected' };
    }
  }

  const value: PhoneReport = {
    schemaVersion: 1,
    slug: input.slug,
    reachedHuman: input.reachedHuman,
    secondsBucket: input.secondsBucket as PhoneReport['secondsBucket'],
    stepsMatched: input.stepsMatched,
    clientNonce: input.clientNonce,
  };
  if (input.steps !== undefined) value.steps = input.steps as PhoneStep[];
  if (input.altPhone !== undefined) value.altPhone = input.altPhone as string;
  return { ok: true, value };
}

export function validateStatsBatch(input: unknown): input is { slugs: string[] } {
  if (!isRecord(input) || !hasOnlyKeys(input, new Set(['slugs'])) || !Array.isArray(input.slugs)) return false;
  if (input.slugs.length < 1 || input.slugs.length > 60) return false;
  if (!input.slugs.every((slug) => typeof slug === 'string' && SLUG.test(slug))) return false;
  return new Set(input.slugs).size === input.slugs.length;
}
