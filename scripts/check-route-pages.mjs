/**
 * Renders every published route payload through the real core.js and checks
 * the output for the faults that only show up on pages nobody opened.
 *
 * Spot-checking found three of these by hand; this finds the rest.
 *   node scripts/check-route-pages.mjs [--limit N] [--verbose]
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const CORE = path.join(process.cwd(), 'press-zero', 'assets', 'core.js');
const DATA = path.join(process.cwd(), 'press-zero', 'data', 'r');

const args = process.argv.slice(2);
const limit = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : Infinity;
const verbose = args.includes('--verbose');

/* core.js expects a browser. Rendering touches none of it, but the module
   body reads `window` on the way in, so hand it a stand-in. */
const source = await readFile(CORE, 'utf8');
const win = {};
const doc = { querySelector: () => null, createElement: () => ({ style: {}, remove() {} }), head: {}, body: {} };
new Function('window', 'document', 'self', 'navigator', 'matchMedia', source)(
  win, doc, { crypto: undefined }, { userAgent: 'node' }, () => ({ matches: false })
);
const HP = win.HP;
if (!HP || typeof HP.routeHTML !== 'function') throw new Error('core.js did not expose routeHTML');
if (HP.canonNumber('800-555-1212 ext 99') !== '8005551212') throw new Error('phone extension parsing regressed');
if (HP.canonNumber('٨٠٠-٥٥٥-١٢١٢') !== '8005551212') throw new Error('Unicode digit parsing regressed');

const PAIRED = ['div', 'section', 'aside', 'details', 'summary', 'p', 'span', 'ul', 'li', 'a', 'button', 'h1', 'h2', 'h3', 'h4', 'svg', 'address', 'symbol'];

function tagBalance(html) {
  const bad = [];
  for (const tag of PAIRED) {
    const open = (html.match(new RegExp('<' + tag + '(?=[\\s>/])', 'g')) || []).length;
    const selfClosed = (html.match(new RegExp('<' + tag + '\\b[^>]*/>', 'g')) || []).length;
    const close = (html.match(new RegExp('</' + tag + '>', 'g')) || []).length;
    if (open - selfClosed !== close) bad.push(`${tag} ${open - selfClosed}/${close}`);
  }
  return bad;
}

function telNumbers(html) {
  return Array.from(html.matchAll(/href="tel:([^"]+)"/g), (m) => HP.canonNumber(m[1])).filter(Boolean);
}

const checks = [
  ['renders', (h) => (h && h.trim() ? null : 'empty output')],
  ['no-undefined', (h) => (h.includes('undefined') ? 'literal "undefined" in output' : null)],
  ['no-object-object', (h) => (h.includes('[object Object]') ? 'literal "[object Object]"' : null)],
  ['no-nan', (h) => (/\bNaN\b/.test(h) ? 'literal NaN' : null)],
  ['no-bad-plural', (h) => (/\b1 steps\b/.test(h) ? '"1 steps"' : null)],
  ['no-empty-href', (h) => (h.includes('href=""') ? 'empty href' : null)],
  ['no-active-markup', (h) => (/<(?:script|iframe|object|embed|base|form)\b|\son[a-z]+\s*=/i.test(h)
    ? 'active markup or inline event handler' : null)],
  ['safe-href-schemes', (h) => {
    const unsafe = Array.from(h.matchAll(/href="([^"]+)"/g), (match) => match[1]).find(
      (href) => !/^(?:https:|tel:|mailto:|#)/i.test(href),
    );
    return unsafe ? `unsafe href scheme: ${unsafe.slice(0, 80)}` : null;
  }],
  ['country-safe-dial', (h, c) => {
    if (!c.country || c.country === 'US' || c.country === 'CA') return null;
    const hero = /class="dial"[^>]*href="([^"]+)"/.exec(h)?.[1] || '';
    return hero.startsWith('tel:+1') && !String(c.raw || c.phone).trim().startsWith('+1')
      ? `non-NANP number was rewritten as ${hero}`
      : null;
  }],
  ['one-h1', (h) => {
    const n = (h.match(/<h1[\s>]/g) || []).length;
    return n === 1 ? null : `${n} h1 elements`;
  }],
  ['tags-balanced', (h) => {
    const bad = tagBalance(h);
    return bad.length ? 'unbalanced: ' + bad.join(', ') : null;
  }],
  ['hero-not-repeated', (h, c) => {
    if (!c.phone) return null;
    const hero = HP.canonNumber(c.raw || c.phone);
    if (!hero) return null;
    // the first tel: link is the hero itself; any later one must differ
    const rest = telNumbers(h).slice(1);
    return rest.includes(hero) ? 'hero number repeated in the rail' : null;
  }],
  ['no-duplicate-lines', (h) => {
    const nums = telNumbers(h);
    const seen = new Set();
    for (const n of nums) {
      if (seen.has(n)) return 'the same number is listed twice';
      seen.add(n);
    }
    return null;
  }],
  ['trusted-dial-only', (h, c) => {
    if (!c.phone) return null;
    const hasHeroDial = h.includes('id="rdial"');
    const trusted = c.phoneTrust === 'official' || c.phoneTrust === 'corroborated';
    if (!trusted && hasHeroDial) return 'unverified primary number is clickable';
    if (trusted && c.country !== 'INTL' && !hasHeroDial) return 'verified primary number has no dial link';
    return null;
  }],
  ['no-unverified-dial-links', (h, c) => {
    const allowed = new Set();
    if (c.phone && (c.phoneTrust === 'official' || c.phoneTrust === 'corroborated')) {
      allowed.add(HP.canonNumber(c.raw || c.phone));
    }
    for (const phone of c.contact?.phones || []) {
      if (phone.official || new Set(phone.sources || []).size >= 2) {
        allowed.add(HP.canonNumber(phone.e164 || phone.raw));
      }
    }
    for (const number of c.numbers || []) {
      if (new Set(number.sources || []).size >= 2) allowed.add(HP.canonNumber(number.n || number.p));
    }
    const unexpected = telNumbers(h).find((number) => !allowed.has(number));
    return unexpected ? `unverified number is clickable: ${unexpected}` : null;
  }],
];

const routeFiles = (await readdir(DATA, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith('.json'));
const routes = {};
for (const entry of routeFiles) {
  Object.assign(routes, JSON.parse(await readFile(path.join(DATA, entry.name), 'utf8')));
}
const failures = new Map();
let rendered = 0;

for (const [slug, payload] of Object.entries(routes)) {
  if (rendered >= limit) break;
  let out;
  try {
    out = HP.routeHTML(payload);
  } catch (error) {
    const bucket = failures.get('threw') || [];
    bucket.push(`${slug}: ${error.message}`);
    failures.set('threw', bucket);
    rendered += 1;
    continue;
  }

  for (const [name, run] of checks) {
    const problem = run(out, payload);
    if (!problem) continue;
    const bucket = failures.get(name) || [];
    bucket.push(`${slug}: ${problem}`);
    failures.set(name, bucket);
  }

  rendered += 1;
}

console.log(`rendered ${rendered} route payloads`);

if (!failures.size) {
  console.log('all checks passed');
  process.exit(0);
}

let total = 0;
for (const [name, list] of failures) {
  total += list.length;
  console.log(`\n${name}: ${list.length}`);
  for (const line of list.slice(0, verbose ? list.length : 5)) console.log('  ' + line);
  if (!verbose && list.length > 5) console.log(`  … ${list.length - 5} more`);
}
console.log(`\n${total} problems across ${failures.size} checks`);
process.exit(1);
