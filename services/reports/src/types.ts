export const SECONDS_BUCKETS = ['lt_60', '60_300', '300_900', 'gt_900'] as const;
export type SecondsBucket = (typeof SECONDS_BUCKETS)[number];

export type PhoneStep =
  | { kind: 'press'; key: '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '*' | '#' }
  | { kind: 'say' }
  | { kind: 'wait' };

export interface PhoneReport {
  schemaVersion: 1;
  slug: string;
  reachedHuman: boolean;
  secondsBucket: SecondsBucket;
  stepsMatched: boolean;
  steps?: PhoneStep[];
  clientNonce: string;
}

export interface RouteStats {
  slug: string;
  up: number;
  down: number;
  lastConfirmedDay: string | null;
  medianSeconds: number | null;
  sampleCount: number;
  stale: boolean;
}

export interface Env {
  DB: D1Database;
  REPORTS_KV: KVNamespace;
  REPORT_RATE_LIMITER: RateLimit;
  PRODUCTION_ORIGIN: string;
  TURNSTILE_SECRET: string;
  IP_HASH_SECRET: string;
  GITHUB_REPOSITORY: string;
  GITHUB_BASE_BRANCH: string;
  GITHUB_APP_ID: string;
  GITHUB_INSTALLATION_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
}

export interface ValidationResult {
  ok: boolean;
  value?: PhoneReport;
  reasonCode?: string;
}
