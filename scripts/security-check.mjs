import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { assertRouteStats } from './lib/route-stats.mjs';

const root = process.cwd();
const failures = [];

try {
  assertRouteStats(JSON.parse(await readFile(path.join(root, 'data', 'route_stats.json'), 'utf8')));
} catch (error) {
  failures.push(`data/route_stats.json: ${error instanceof Error ? error.message : 'invalid aggregate data'}`);
}

const trackedFiles = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
const trackedEntries = execFileSync('git', ['ls-files', '--stage', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
for (const entry of trackedEntries) {
  const match = /^(\d{6}) [a-f0-9]+ \d\t(.+)$/.exec(entry);
  if (match && (match[1] === '120000' || match[1] === '160000')) {
    failures.push(`${match[2]}: symlinks and submodules are not allowed`);
  }
}
for (const file of trackedFiles) {
  const base = path.basename(file).toLowerCase();
  if (
    ((base === '.env' || base.startsWith('.env.') || base === '.dev.vars' || base.startsWith('.dev.vars.')) && !base.endsWith('.example')) ||
    /\.(?:pem|key)$/i.test(base)
  ) failures.push(`${file}: sensitive file must not be tracked`);
}
try {
  const matches = execFileSync('git', [
    'grep', '-I', '-l', '-E', '-e',
    'gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,}|AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9]{32,}',
    '--', '.',
  ], { cwd: root, encoding: 'utf8' }).trim();
  if (matches) failures.push(`credential-shaped value found in: ${matches.split(/\r?\n/).join(', ')}`);
} catch (error) {
  if (error?.status !== 1) throw error;
}

async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(full));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

for (const workflow of await walk(path.join(root, '.github', 'workflows'))) {
  const text = await readFile(workflow, 'utf8');
  for (const match of text.matchAll(/^\s*- uses:\s*([^\s#]+)/gm)) {
    if (!/@[a-f0-9]{40}$/.test(match[1])) failures.push(`${path.relative(root, workflow)}: action is not SHA-pinned: ${match[1]}`);
  }
}

const requirements = await readFile(path.join(root, 'requirements-scrapers.txt'), 'utf8');
const requirementStarts = [...requirements.matchAll(/^[a-z0-9][a-z0-9._-]*==[^\s\\]+/gmi)];
for (let index = 0; index < requirementStarts.length; index += 1) {
  const start = requirementStarts[index].index;
  const end = requirementStarts[index + 1]?.index ?? requirements.length;
  if (!requirements.slice(start, end).includes('--hash=sha256:')) {
    failures.push(`requirements-scrapers.txt: ${requirementStarts[index][0]} is not hash-pinned`);
  }
}
const validationWorkflow = await readFile(path.join(root, '.github', 'workflows', 'validate.yml'), 'utf8');
const intakeWorkflow = await readFile(path.join(root, '.github', 'workflows', 'ingest-route.yml'), 'utf8');
const normalizedValidationWorkflow = validationWorkflow.replace(/\s+/g, ' ');
if (!/pip install[^\r\n]*--only-binary=:all:[^\r\n]*--require-hashes[^\r\n]*requirements-scrapers\.txt/.test(normalizedValidationWorkflow)) {
  failures.push('.github/workflows/validate.yml: Python dependencies are not installed with --require-hashes');
}
if (!/npm ci --ignore-scripts/.test(validationWorkflow)) {
  failures.push('.github/workflows/validate.yml: npm lifecycle scripts are not disabled during dependency installation');
}
if (!/npm audit --audit-level=low/.test(validationWorkflow)) {
  failures.push('.github/workflows/validate.yml: npm audit is missing');
}
for (const [name, workflow] of [['validate.yml', validationWorkflow], ['ingest-route.yml', intakeWorkflow]]) {
  if (!/node-version:\s*24\b/.test(workflow)) failures.push(`.github/workflows/${name}: supported Node 24 LTS is required`);
}
if (/^\s*issues:\s*write\s*$/m.test(intakeWorkflow) || /gh issue comment/.test(intakeWorkflow)) {
  failures.push('.github/workflows/ingest-route.yml: intake must not have issue-write or bot-comment capability');
}
const packageManifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
if (packageManifest.engines?.node !== '>=24') failures.push('package.json: supported Node 24 LTS is required');
if (packageManifest.scripts?.['site:stats'] !== 'node press-zero/tools/build-data.mjs') {
  failures.push('package.json: reviewed stats must be baked through the validated data builder');
}
if (packageManifest.scripts?.['security:live'] !== 'node scripts/verify-live-security.mjs') {
  failures.push('package.json: live post-deployment security verification is missing');
}
const buildData = await readFile(path.join(root, 'press-zero', 'tools', 'build-data.mjs'), 'utf8');
if (!/assertRouteStats/.test(buildData) || !/routeStats\.get\(listing\.slug\)/.test(buildData)) {
  failures.push('press-zero/tools/build-data.mjs: reviewed aggregate validation or attachment is missing');
}

for (const file of await walk(path.join(root, 'press-zero', 'assets'))) {
  const relative = path.relative(root, file).replaceAll('\\', '/');
  if (relative.endsWith('.css')) {
    const css = await readFile(file, 'utf8');
    const activeCss = css.replace(/\/\*[\s\S]*?\*\//g, '');
    if (/@import\b|(?:https?|javascript):/i.test(activeCss)) failures.push(`${relative}: remote import or active CSS URL`);
  }
  if (relative.endsWith('.js')) {
    const javascript = await readFile(file, 'utf8');
    if (/\beval\s*\(|\bnew\s+Function\s*\(|document\.write\s*\(/.test(javascript)) {
      failures.push(`${relative}: dynamic code execution sink`);
    }
  }
}

const coreJavascript = await readFile(path.join(root, 'press-zero', 'assets', 'core.js'), 'utf8');
if (/\/v1\/stats(?:\/|['"])/.test(coreJavascript) || /\bfetchStats\b/.test(coreJavascript)) {
  failures.push('press-zero/assets/core.js: unreviewed Worker aggregates must not replace baked stats');
}
if (/\baltPhone\b|\bpad-no\b/.test(coreJavascript)) {
  failures.push('press-zero/assets/core.js: unused alternate phone data must not be collected');
}
const workerIndex = await readFile(path.join(root, 'services', 'reports', 'src', 'index.ts'), 'utf8');
if (/url\.pathname[^\r\n]*['"]\/v1\/stats/.test(workerIndex)) {
  failures.push('services/reports/src/index.ts: raw aggregate stats endpoint is public');
}
const wranglerConfig = await readFile(path.join(root, 'services', 'reports', 'wrangler.toml'), 'utf8');
if (!/\[\[ratelimits\]\][\s\S]*name\s*=\s*"REPORT_RATE_LIMITER"[\s\S]*limit\s*=\s*20[\s\S]*period\s*=\s*60/.test(wranglerConfig) ||
    !/REPORT_RATE_LIMITER\.limit/.test(workerIndex)) {
  failures.push('services/reports: Cloudflare edge rate limiting is not enforced');
}
const workerStore = await readFile(path.join(root, 'services', 'reports', 'src', 'store.ts'), 'utf8');
if (!/HAVING COUNT\(DISTINCT hex\(reporter_bucket\)\) >= 3/.test(workerStore)) {
  failures.push('services/reports/src/store.ts: reviewed aggregates lack reporter quorum');
}
if (/\breport\.altPhone\b/.test(workerStore)) failures.push('services/reports/src/store.ts: alternate phone data is still stored');
const reportSchema = JSON.parse(await readFile(path.join(root, 'schema', 'phone-report.schema.json'), 'utf8'));
if (Object.hasOwn(reportSchema.properties ?? {}, 'altPhone')) {
  failures.push('schema/phone-report.schema.json: alternate phone data is still accepted');
}

for (const file of await walk(path.join(root, 'press-zero'))) {
  const relative = path.relative(root, file).replaceAll('\\', '/');
  if (!relative.endsWith('.html') || relative === 'press-zero/dist/human-please.html') continue;
  const html = await readFile(file, 'utf8');
  if (/<script(?![^>]*\bsrc=)[^>]*>/i.test(html)) failures.push(`${relative}: inline script`);
  if (/\son[a-z]+\s*=/i.test(html)) failures.push(`${relative}: inline event handler`);
  if (/\sstyle\s*=/i.test(html)) failures.push(`${relative}: inline style`);
  if (/<a\b[^>]*href\s*=\s*["']\s*(?:javascript|data|vbscript):/i.test(html)) failures.push(`${relative}: active-content link`);
  for (const match of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']*)["']/gi)) {
    const href = match[1].trim();
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(href)?.[1].toLowerCase();
    if (href.startsWith('//') || href.includes('\\') || (scheme && !['https', 'tel', 'mailto'].includes(scheme))) {
      failures.push(`${relative}: disallowed anchor target ${href.slice(0, 100)}`);
    }
  }
  if (/<link\b[^>]*rel=["']stylesheet["'][^>]*href=["']https?:/i.test(html)) failures.push(`${relative}: third-party stylesheet`);
}

const fontsCss = await readFile(path.join(root, 'press-zero', 'assets', 'fonts.css'), 'utf8');
if (/https?:/i.test(fontsCss)) failures.push('press-zero/assets/fonts.css: remote font URL');
const referencedFonts = new Set();
for (const match of fontsCss.matchAll(/url\(fonts\/([^)]+)\)/g)) {
  referencedFonts.add(match[1]);
  try {
    await readFile(path.join(root, 'press-zero', 'assets', 'fonts', match[1]));
  } catch {
    failures.push(`press-zero/assets/fonts.css: missing font ${match[1]}`);
  }
}
const fontSums = await readFile(path.join(root, 'press-zero', 'assets', 'fonts', 'SHA256SUMS'), 'utf8');
const pinnedFonts = new Set();
for (const line of fontSums.trim().split(/\r?\n/)) {
  const match = /^([a-f0-9]{64})  ([^/\\]+\.woff2)$/.exec(line);
  if (!match) {
    failures.push('press-zero/assets/fonts/SHA256SUMS: invalid entry');
    continue;
  }
  pinnedFonts.add(match[2]);
  const content = await readFile(path.join(root, 'press-zero', 'assets', 'fonts', match[2]));
  if (createHash('sha256').update(content).digest('hex') !== match[1]) failures.push(`${match[2]}: font hash mismatch`);
}
if ([...referencedFonts].some((file) => !pinnedFonts.has(file)) || [...pinnedFonts].some((file) => !referencedFonts.has(file))) {
  failures.push('font CSS and SHA256SUMS do not name the same files');
}

const bundle = await readFile(path.join(root, 'press-zero', 'dist', 'human-please.html'), 'utf8');
const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/i.exec(bundle)?.[1] || '';
const scriptPolicy = /(?:^|; )script-src ([^;]+)/.exec(csp)?.[1] || '';
const stylePolicy = /(?:^|; )style-src ([^;]+)/.exec(csp)?.[1] || '';
if (!scriptPolicy || scriptPolicy.includes("'unsafe-inline'") || !scriptPolicy.includes("'sha256-")) {
  failures.push('press-zero/dist/human-please.html: missing hash-only inline-script CSP');
}
if (!stylePolicy || stylePolicy.includes("'unsafe-inline'") || !stylePolicy.includes("'sha256-")) {
  failures.push('press-zero/dist/human-please.html: missing hash-only inline-style CSP');
}
for (const directive of ["base-uri 'none'", "object-src 'none'", "form-action 'none'", "script-src-attr 'none'", "style-src-attr 'none'", "worker-src 'none'"]) {
  if (!csp.includes(directive)) failures.push(`press-zero/dist/human-please.html: CSP is missing ${directive}`);
}
for (const match of bundle.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
  const hash = `'sha256-${createHash('sha256').update(match[1]).digest('base64')}'`;
  if (!scriptPolicy.includes(hash)) failures.push('press-zero/dist/human-please.html: inline script hash mismatch');
}
for (const match of bundle.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) {
  const hash = `'sha256-${createHash('sha256').update(match[1]).digest('base64')}'`;
  if (!stylePolicy.includes(hash)) failures.push('press-zero/dist/human-please.html: inline style hash mismatch');
}

for (const file of await walk(path.join(root, 'press-zero', 'assets', 'flags'))) {
  if (!file.endsWith('.svg')) continue;
  const svg = await readFile(file, 'utf8');
  if (/<script\b|<foreignObject\b|\son[a-z]+\s*=|(?:href|src)\s*=\s*["'](?:https?:|data:|javascript:)/i.test(svg)) {
    failures.push(`${path.relative(root, file)}: active or remote SVG content`);
  }
}

const nginx = await readFile(path.join(root, 'deploy', 'nginx-security.conf'), 'utf8');
for (const directive of [
  "base-uri 'none'", "object-src 'none'", "form-action 'none'", "script-src-attr 'none'",
  "style-src-attr 'none'", "frame-ancestors 'none'", "worker-src 'none'",
]) {
  if (!nginx.includes(directive)) failures.push(`deploy/nginx-security.conf: CSP is missing ${directive}`);
}

for (const file of await walk(path.join(root, 'press-zero', 'data', 'r'))) {
  if (!file.endsWith('.json')) continue;
  const shard = JSON.parse(await readFile(file, 'utf8'));
  for (const company of Object.values(shard)) {
    if (company.phone && !['official', 'corroborated', 'single'].includes(company.phoneTrust)) {
      failures.push(`${company.slug}: missing or invalid phone trust classification`);
    }
    const values = [
      company.url,
      ...(company.contact?.websites || []),
      ...(company.contact?.channels || []).map((channel) => channel.url),
      ...(company.contact?.phones || []).map((phone) => phone.sourceUrl),
    ].filter(Boolean);
    for (const value of values) {
      try {
        const parsed = new URL(value);
        const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
        const privateName = !host.includes('.') || /(?:^|\.)(?:localhost|local|internal|home|lan)$/.test(host);
        const ipLiteral = host.includes(':') || /^\d+(?:\.\d+){0,3}$/.test(host);
        if (parsed.protocol !== 'https:' || parsed.username || parsed.password || privateName || ipLiteral) throw new Error('scheme');
      } catch {
        failures.push(`${company.slug}: unsafe URL ${String(value).slice(0, 100)}`);
      }
    }
    for (const phone of company.contact?.phones || []) {
      if (!Array.isArray(phone.sources)) failures.push(`${company.slug}: phone source provenance is missing`);
    }
    for (const email of company.contact?.emails || []) {
      if (email.length > 254 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(email)) {
        failures.push(`${company.slug}: invalid email address`);
      }
    }
  }
}

if (failures.length) {
  for (const failure of failures.slice(0, 100)) console.error(failure);
  console.error(`${failures.length} security invariant${failures.length === 1 ? '' : 's'} failed`);
  process.exit(1);
}

console.log('Security invariants passed.');
