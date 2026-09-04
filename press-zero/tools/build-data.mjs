// build-data.mjs — turns the raw scrape into the shape the site actually needs.
// In:  ../../data/{phone_routes,master_contacts,coverage}.json
// Out: ../data/index.json, ../data/r/<letter>.json, ../data/stats.json
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertRouteStats } from '../../scripts/lib/route-stats.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const RAW = path.join(here, '..', '..', 'data');
const OUT = path.join(here, '..', 'data');

const routes = JSON.parse(fs.readFileSync(path.join(RAW, 'phone_routes.json'), 'utf8'));
const master = JSON.parse(fs.readFileSync(path.join(RAW, 'master_contacts.json'), 'utf8'));
const coverage = JSON.parse(fs.readFileSync(path.join(RAW, 'coverage.json'), 'utf8'));
const routeStats = new Map(assertRouteStats(
  JSON.parse(fs.readFileSync(path.join(RAW, 'route_stats.json'), 'utf8')),
).map((row) => [row.slug, row]));
const readOptional = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(path.join(RAW, file), 'utf8')); }
  catch { return fallback; }
};
const official = readOptional(path.join('global_official_phones', 'all.json'), { records: [] });
const deep = readOptional(path.join('top100_deep_contacts', 'all.json'), { companies: [] });

/* ---------- helpers ---------- */

const UNSAFE_TEXT_CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g;
const sanitizeTextValues = (value) => {
  if (typeof value === 'string') return value.replace(UNSAFE_TEXT_CONTROLS, '');
  if (Array.isArray(value)) return value.map(sanitizeTextValues);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeTextValues(item)]));
  }
  return value;
};

const slugify = (s) =>
  s.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// scraped names carry junk from page titles
const cleanName = (s) =>
  s
    .replace(/^(how to contact|contact|call)\s+/i, '')
    .replace(/\s+(customer service|support)$/i, '')
    .replace(/\s+com$/i, '.com')
    .trim();

const pretty = (n) => {
  const d = String(n || '').replace(/\D/g, '');
  if (d.length === 11 && d[0] === '1') return pretty(d.slice(1));
  if (d.length === 10) return d.slice(0, 3) + ' ' + d.slice(3, 6) + ' ' + d.slice(6);
  return d || '';
};

const deptFromUrl = (u) => {
  const m =
    /\/phone-number\/[^/]+\/([^/]+)\//.exec(u || '') ||
    /contacthelp\.com\/[^/]+\/([^/?#]+)/.exec(u || '');
  if (!m) return '';
  return m[1].replace(/-/g, ' ').replace(/~.*$/, '').trim();
};

// source bookkeeping like "main (Elliott listing)" is not a department name
const cleanDept = (d) => String(d || '').replace(/\s*\([^)]*\)/g, '').trim();

const phoneDigits = (value) => {
  const raw = String(value || '').trim();
  const expanded = [...raw.matchAll(/\(([^)]+)\)/g)]
    .map((match) => match[1].replace(/\D/g, ''))
    .findLast((digits) => digits.length >= 7 && digits.length <= 15);
  if (expanded) return expanded;
  const keypad = { A: 2, B: 2, C: 2, D: 3, E: 3, F: 3, G: 4, H: 4, I: 4,
    J: 5, K: 5, L: 5, M: 6, N: 6, O: 6, P: 7, Q: 7, R: 7, S: 7,
    T: 8, U: 8, V: 8, W: 9, X: 9, Y: 9, Z: 9 };
  return raw.split(/\b(?:ext(?:ension)?|x)\b/i, 1)[0].toUpperCase()
    .replace(/[A-Z]/g, (letter) => keypad[letter])
    .replace(/\D/g, '');
};

const samePhone = (a, b) => {
  const left = phoneDigits(a);
  const right = phoneDigits(b);
  if (!left || !right) return false;
  if (left === right) return true;
  if (left.length === 11 && left[0] === '1' && right.length === 10) return left.slice(1) === right;
  if (right.length === 11 && right[0] === '1' && left.length === 10) return right.slice(1) === left;
  return false;
};

const normalizeCountries = (values) => [...new Set((values || []).flatMap((value) => {
  const code = String(value || '').trim().toUpperCase();
  if (code === 'UNITED STATES AND CANADA' || code === 'US AND CANADA') return ['US', 'CA'];
  if (code === 'ZZ' || code === 'GLOBAL' || code === 'WORLDWIDE') return ['INTL'];
  return /^[A-Z]{2}$/.test(code) ? [code] : [];
}))];

const contactPhone = ({ raw, e164 = null, countries = [], dept = '', use = '', hours = null,
  timezone = null, sourceUrl = '', evidence = '', sources = [], official: isOfficial = false, deep: isDeep = false }) => ({
  raw: String(raw || '').trim(),
  e164: e164 || null,
  countries: normalizeCountries(countries),
  dept: cleanDept(dept) || 'Customer support',
  use: String(use || '').trim(),
  hours: hours || null,
  timezone: timezone || null,
  sourceUrl: safeWebsite(sourceUrl),
  evidence: evidence || '',
  sources: [...new Set((sources || []).map((source) => String(source || '').trim()).filter(Boolean))],
  official: !!isOfficial,
  deep: !!isDeep,
});

function mergeContactPhones(list) {
  const out = new Map();
  for (const phone of list.filter((p) => p.raw)) {
    const key = [phoneDigits(phone.e164 || phone.raw), phone.countries.join(','), phone.dept.toLowerCase()].join('|');
    const current = out.get(key);
    const quality = (item) => Number(item.deep) * 8 + Number(item.official) * 4 + Number(!!item.hours) * 2 + Number(!!item.sourceUrl);
    if (!current) {
      out.set(key, phone);
      continue;
    }
    const preferred = quality(phone) > quality(current) ? phone : current;
    out.set(key, {
      ...preferred,
      official: current.official || phone.official,
      deep: current.deep || phone.deep,
      sources: [...new Set([...(current.sources || []), ...(phone.sources || [])])],
    });
  }
  return [...out.values()].sort((a, b) =>
    Number(b.deep) - Number(a.deep) || Number(b.official) - Number(a.official) ||
    a.countries.join().localeCompare(b.countries.join()) || a.dept.localeCompare(b.dept)
  );
}

const phoneTrust = (value, phones) => {
  const matches = phones.filter((phone) => samePhone(value, phone.e164 || phone.raw));
  if (matches.some((phone) => phone.official)) return 'official';
  const sources = new Set(matches.flatMap((phone) => phone.sources || []));
  return sources.size >= 2 ? 'corroborated' : 'single';
};

const safeWebsite = (value) => {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    const privateName = !host.includes('.') || /(?:^|\.)(?:localhost|local|internal|home|lan)$/.test(host);
    const ipLiteral = host.includes(':') || /^\d+(?:\.\d+){0,3}$/.test(host);
    if (url.protocol === 'https:' && !url.username && !url.password && !privateName && !ipLiteral) return url.href;
  } catch { /* malformed source data */ }
  return '';
};

const uniqueWebsites = (values) => {
  const out = new Map();
  for (const value of values) {
    const href = safeWebsite(value);
    if (!href) continue;
    const url = new URL(href);
    const key = `${url.hostname.toLowerCase().replace(/^www\./, '')}${url.pathname.replace(/\/$/, '')}${url.search}`;
    const current = out.get(key);
    if (!current || (current.startsWith('http:') && href.startsWith('https:'))) out.set(key, href);
  }
  return [...out.values()];
};

// Master contacts contain person-addressed email in a few records. The site only
// exposes role mailboxes that are useful as an organization-level contact route.
const publicRoleEmail = (value) => {
  const email = String(value || '').trim();
  return email.length <= 254 && /^(support|help|care|service|customerservice|info|contact|sales|orders?|billing|privacy|accessibility|claims?|returns?|feedback|media|press|office|admin)[+._-]?[a-z0-9-]*@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(email);
};

const waitSeconds = (s) => {
  if (!s) return null;
  const m = /(\d+)\s*(min|hour|hr|sec)/i.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  if (/hour|hr/i.test(m[2])) return n * 3600;
  if (/sec/i.test(m[2])) return n;
  return n * 60;
};

/* ---------- step parsing ----------
   Raw steps arrive as freeform blobs ("Press 0, then enter zip code, then press 5").
   Split them into atomic actions so the UI can show one instruction at a time. */

const SPLIT = /\s*(?:,?\s*then\s+|;\s*|\s*->\s*|(?<=\.)\s+(?=[A-Z]))/i;

function atomize(raw) {
  const out = [];
  for (const chunk of String(raw).split(SPLIT)) {
    const t = chunk
      .replace(/\((?:star|asterisk)\)/gi, '')
      .replace(/\((?:pound|hash)\)/gi, '')
      .trim()
      .replace(/^[-\s]+/, '')
      .replace(/\s+/g, ' ');
    if (!t) continue;
    out.push(...classify(t));
  }
  return out;
}

function classify(t) {
  const low = t.toLowerCase();

  // a chunk that is nothing but keys — "1+1", "* ", "0, 0" — is still a keypress
  const bare = t.replace(/ (again|once more|one more time)$/i, '').replace(/[ ,+.]/g, '');
  if (/^[0-9*#]{1,6}$/.test(bare)) {
    return bare.split('').map((k) => mk('press', k, '', 4));
  }

  const repeat = /\b(keep|repeatedly|repeat)\b/i.test(t);
  const needsInput = /zip|account|phone number|social|member|policy|card|last four/i.test(low);

  const press = /(?:press(?:ing)?|dial|hit|enter)\s+["'#]?\s*([0-9*#](?:\s*(?:,|and|then)?\s*["']?[0-9*#]["']?)*)/i.exec(t);
  if (press && !needsInput) {
    const keys = press[1].match(/[0-9*#]/g) || [];
    if (keys.length > 1 && !repeat) return keys.map((k) => mk('press', k, '', 4));
    if (keys.length === 1) {
      return [mk('press', keys[0], repeat ? 'keep pressing it, ignore the prompts' : trailing(t), repeat ? 12 : 4)];
    }
  }

  if (/\b(say|speak|ask for|state)\b/i.test(low)) {
    // straight quotes first — apostrophes in "don't" must not open a quote
    const q =
      /"([^"]{2,40})"/.exec(t) ||
      /[“]([^”]{2,40})[”]/.exec(t) ||
      (t.includes("'") && !/\w'\w/.test(t) ? /'([^']{2,40})'/.exec(t) : null);
    const guess = /\b(?:say|speak|ask for|state)\s+(?:the\s+word\s+)?([a-z ]{3,24})/i.exec(t);
    let word = (q && q[1]) || (guess && guess[1]) || 'representative';
    word = word.trim().replace(/\.$/, '');
    while (/\s(the|a|an|you|your|for|and|to|of|is|are|that|it)$/i.test(word)) word = word.replace(/\s\w+$/, '');
    if (/\b(press|say|zero|whatever)\b/i.test(word) && q) word = q[1];
    else if (/\b(press|whatever)\b/i.test(word)) word = 'representative';
    return [mk('say', word, trailing(t), 5)];
  }

  if (needsInput) {
    const what = /zip/i.test(low)
      ? 'zip code'
      : /account/i.test(low)
        ? 'account number'
        : /member/i.test(low)
          ? 'member id'
          : /policy/i.test(low)
            ? 'policy number'
            : /social|last four/i.test(low)
              ? 'ssn digits'
              : 'phone number';
    return [mk('enter', what, t, 9)];
  }

  if (/\b(wait|hold|stay on|silence|do nothing|ignore|remain)\b/i.test(low)) {
    return [mk('wait', 'hold', t, 15)];
  }

  return [mk('do', '', t, 8)];
}

// the human-readable "why" that follows the mechanical bit
function trailing(t) {
  return t
    .replace(/^(?:press|dial|hit|enter|say|speak)\s+["'#]?[0-9*#a-z ,]*["']?\s*/i, '')
    .replace(/^(?:to|for|and)\s+/i, '')
    .replace(/\.$/, '')
    .trim();
}

function mk(kind, key, note, secs) {
  return { kind, key, note: (note || '').trim(), secs };
}

/* ---------- hours ---------- */

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const DAYIDX = { mon: 0, tue: 1, wed: 2, thu: 3, fri: 4, sat: 5, sun: 6 };

function clock(s) {
  const m = /(\d{1,2})(?::(\d{2}))?\s*([ap])/i.exec(s);
  if (!m) return null;
  let h = Number(m[1]) % 12;
  if (m[3].toLowerCase() === 'p') h += 12;
  return h + Number(m[2] || 0) / 60;
}

function parseHours(list) {
  const joined = (Array.isArray(list) ? list : [list]).filter(Boolean).join(' | ');
  if (/24\s*hours?\s*a\s*day|24\/7/i.test(joined)) {
    return { always: true, days: DAYS.map(() => [0, 24]) };
  }
  const days = DAYS.map(() => null);
  let hit = false;
  const re =
    /(mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)[a-z]*\.?\s*(?:-|to|thru|through)?\s*(mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)?[a-z]*\.?\s*:?\s*(\d{1,2}(?::\d{2})?\s*[ap]\.?m?\.?)\s*(?:-|to)\s*(\d{1,2}(?::\d{2})?\s*[ap]\.?m?\.?)/gi;
  let m;
  while ((m = re.exec(joined))) {
    const a = DAYIDX[m[1].slice(0, 3).toLowerCase()];
    const b = m[2] ? DAYIDX[m[2].slice(0, 3).toLowerCase()] : a;
    const from = clock(m[3]);
    const to = clock(m[4]);
    if (from == null || to == null || a == null || b == null) continue;
    hit = true;
    for (let i = a, guard = 0; guard < 8; i = (i + 1) % 7, guard++) {
      days[i] = [from, to <= from ? 24 : to];
      if (i === b) break;
    }
  }
  return hit ? { always: false, days } : null;
}

/* ---------- assemble ---------- */

const byCompany = new Map();
const ensureCompany = (rawName) => {
  const name = cleanName(rawName || '');
  const slug = slugify(name);
  if (!name || name.length < 2 || !slug) return null;
  if (!byCompany.has(slug)) byCompany.set(slug, { slug, name, rows: [] });
  return byCompany.get(slug);
};

for (const r of routes) {
  const company = ensureCompany(r.company);
  if (company) company.rows.push(r);
}

const masterBySlug = new Map();
for (const [k, v] of Object.entries(master)) {
  const company = ensureCompany(v.display_name || k);
  if (company) masterBySlug.set(company.slug, v);
}

const officialBySlug = new Map();
for (const record of official.records || []) {
  const company = ensureCompany(record.company);
  if (!company) continue;
  if (!officialBySlug.has(company.slug)) officialBySlug.set(company.slug, []);
  officialBySlug.get(company.slug).push(record);
}

const deepBySlug = new Map();
for (const record of deep.companies || []) {
  const company = ensureCompany(record.company);
  if (company) deepBySlug.set(company.slug, record);
}

const companies = [];

for (const c of byCompany.values()) {
  const mrec = masterBySlug.get(c.slug);
  const officialRecords = officialBySlug.get(c.slug) || [];
  const deepRecord = deepBySlug.get(c.slug) || null;
  const contactPhones = [];

  for (const p of mrec?.phones || []) {
    contactPhones.push(contactPhone({
      raw: p.pretty || p.number,
      countries: [],
      dept: (p.departments || []).find((d) => d && d !== 'listed on page'),
      sourceUrl: '',
      evidence: `Listed in the ${mrec.sources?.join(', ') || 'merged'} contact dataset.`,
      sources: mrec.sources || [],
    }));
  }
  for (const p of officialRecords) {
    contactPhones.push(contactPhone({
      raw: p.phone_raw,
      e164: p.phone_e164,
      countries: [p.country_code],
      dept: p.department,
      use: p.service_variant,
      hours: p.hours_raw,
      timezone: p.hours_timezone,
      sourceUrl: p.source_url,
      evidence: p.evidence,
      sources: [p.source_url || 'official-record'],
      official: true,
    }));
  }
  for (const p of deepRecord?.phones || []) {
    contactPhones.push(contactPhone({
      raw: p.phone_raw,
      e164: p.phone_e164,
      countries: p.country_codes,
      dept: p.department,
      use: p.use_case,
      hours: p.hours_raw,
      timezone: p.hours_timezone,
      sourceUrl: p.source_url,
      evidence: p.evidence,
      sources: [p.source_url || 'deep-official-record'],
      official: true,
      deep: true,
    }));
  }

  const phones = new Map();
  for (const p of mrec?.phones || []) {
    phones.set(p.number, {
      n: p.number,
      p: pretty(p.number),
      dept: cleanDept((p.departments || []).filter((d) => d && d !== 'listed on page')[0]),
      tf: !!p.tollfree,
      sources: [...new Set(mrec.sources || [])],
    });
  }
  for (const r of c.rows) {
    if (r.phone) {
      const existing = phones.get(r.phone);
      if (!existing) phones.set(r.phone, {
        n: r.phone,
        p: pretty(r.phone),
        dept: deptFromUrl(r.source_url),
        tf: /^8(00|33|44|55|66|77|88)/.test(r.phone),
        sources: [r.source].filter(Boolean),
      });
      else existing.sources = [...new Set([...(existing.sources || []), r.source].filter(Boolean))];
    }
    if (r.phone) contactPhones.push(contactPhone({
      raw: pretty(r.phone),
      countries: [],
      dept: deptFromUrl(r.source_url),
      use: 'Phone-menu route',
      sourceUrl: r.source_url,
      evidence: `Route listed by ${r.source || 'a public contact source'}.`,
      sources: [r.source].filter(Boolean),
    }));
  }

  const mergedContactPhones = mergeContactPhones(contactPhones);

  const cands = c.rows.map((r) => {
    const steps = (r.steps || []).flatMap(atomize).slice(0, 8);
    const hold = waitSeconds(r.wait_time);
    const walk = steps.reduce((a, s) => a + s.secs, 0);
    return {
      steps,
      hold,
      walk,
      total: hold == null ? null : walk + hold,
      phone: r.phone || '',
      dept: deptFromUrl(r.source_url),
      src: r.source,
      url: safeWebsite(r.source_url),
      quiet: (/least busy day to call .*? is (\w+)/i.exec(r.best_time_to_call || '') || [])[1] || '',
      hoursRaw: r.hours,
    };
  });

  const scored = cands.slice().sort((a, b) => {
    const sa = a.steps.length ? 1 : 0;
    const sb = b.steps.length ? 1 : 0;
    if (sa !== sb) return sb - sa;
    if (a.steps.length !== b.steps.length) return b.steps.length - a.steps.length;
    return (a.total == null ? 1e9 : a.total) - (b.total == null ? 1e9 : b.total);
  });

  const best = scored[0] || { steps: [], hold: null, walk: 0, total: null, phone: '', dept: '', src: '', url: '', hoursRaw: null };
  const routePrimary =
    (best.phone && phones.get(best.phone)) ||
    [...phones.values()].find((p) => /customer service|support|main/i.test(p.dept)) ||
    [...phones.values()].find((p) => p.tf) ||
    [...phones.values()][0] || null;
  const preferredContact =
    mergedContactPhones.find((p) => p.deep && /customer|support|orders?|technical|consumer/i.test(p.dept + ' ' + p.use)) ||
    mergedContactPhones.find((p) => p.deep) ||
    mergedContactPhones.find((p) => p.official && /customer|support|orders?|technical|consumer/i.test(p.dept + ' ' + p.use)) ||
    mergedContactPhones.find((p) => p.official) || mergedContactPhones[0] || null;
  const primary = best.steps.length && routePrimary ? routePrimary : preferredContact ? {
    n: preferredContact.e164 || phoneDigits(preferredContact.raw),
    p: preferredContact.raw,
    dept: preferredContact.dept,
    tf: false,
  } : routePrimary;
  const primaryDigits = phoneDigits(primary?.n || primary?.p);
  const primaryContact = primaryDigits
    ? mergedContactPhones.find((p) => samePhone(p.e164 || p.raw, primaryDigits))
    : preferredContact;
  const primaryPhoneTrust = primary ? phoneTrust(primary.n || primary.p, mergedContactPhones) : null;

  const hours = parseHours([...(mrec?.hours || []), best.hoursRaw]);
  const quiet = cands.map((x) => x.quiet).find(Boolean) || '';
  const holds = cands.map((x) => x.hold).filter((x) => x != null);

  const alts = scored
    .slice(1)
    .filter((x) => x.steps.length || (x.phone && x.dept))
    // the whole point of the page is speed, so rank them by it
    .sort((a, b) => (a.total == null ? 1e9 : a.total) - (b.total == null ? 1e9 : b.total))
    .slice(0, 4)
    .map((x) => ({
      dept: x.dept || 'other line',
      phone: x.phone ? pretty(x.phone) : primary ? primary.p : '',
      steps: x.steps,
      hold: x.hold,
      total: x.total,
      src: x.src,
      url: x.url,
    }));

  const contactChannels = (deepRecord?.contact_channels || []).map((channel) => ({
    type: channel.channel_type || 'Official contact route',
    url: safeWebsite(channel.url),
    countries: normalizeCountries(channel.country_codes || []),
    hours: channel.hours_raw || null,
    timezone: channel.hours_timezone || null,
    loginRequired: channel.login_required,
    sourceUrl: safeWebsite(channel.source_url || channel.url),
    evidence: channel.evidence || '',
  })).filter((channel) => channel.url);

  const websites = uniqueWebsites(mrec?.websites || []);
  const emails = [...new Set((mrec?.emails || []).filter(publicRoleEmail))];
  const addresses = [...new Set(mrec?.addresses || [])];
  if (!best.steps.length && !primary && !contactChannels.length && !websites.length && !emails.length && !addresses.length) continue;

  companies.push(sanitizeTextValues({
    slug: c.slug,
    name: c.name,
    phone: primary ? primary.p : '',
    raw: primary ? primary.n : '',
    dept: primary ? primary.dept : '',
    phoneTrust: primaryPhoneTrust,
    steps: best.steps,
    walk: best.walk,
    hold: best.hold,
    total: best.total,
    holdLow: holds.length ? Math.min(...holds) : null,
    holdHigh: holds.length ? Math.max(...holds) : null,
    quiet,
    hours,
    primaryHoursRaw: best.steps.length ? null : primaryContact?.hours || null,
    primaryHoursTimezone: best.steps.length ? null : primaryContact?.timezone || null,
    numbers: [...phones.values()].slice(0, 8),
    alts,
    contact: {
      phones: mergedContactPhones,
      channels: contactChannels,
      websites,
      emails,
      addresses,
      coverage: deepRecord?.coverage || null,
      routingNotes: deepRecord?.routing_notes || [],
      gaps: deepRecord?.gaps || [],
      deepReviewed: !!deepRecord,
    },
    sources: [...new Set(cands.map((x) => x.src).filter(Boolean))],
    src: best.src,
    url: best.url,
    confidence: best.steps.length >= 2 ? 'high' : best.steps.length ? 'medium' : 'low',
  }));
}

const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
const regionName = (code) => {
  if (code === 'INTL') return 'International';
  try { return regionNames.of(code) || code; }
  catch { return code; }
};

function notesForCountry(items, code, companyCountries, companyPhones) {
  return (items || []).filter((item) => {
    const text = String(typeof item === 'string' ? item : JSON.stringify(item));
    const searchable = text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const phoneMentions = [...new Set(companyPhones.flatMap((phone) => {
      const aliases = [phone.raw, ...(String(phone.raw || '').match(/\(([^)]+)\)/) || []).slice(1)]
        .flatMap((raw) => [String(raw || '').split('(')[0]])
        .map((raw) => raw.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim())
        .filter((alias) => alias.length >= 7);
      return aliases.some((alias) => searchable.includes(alias)) ? phone.countries : [];
    }))];
    if (phoneMentions.length) return phoneMentions.includes(code);
    const mentioned = companyCountries.filter((candidate) => {
      if (candidate === 'US') return /\b(?:US|U\.S\.|United States)\b/i.test(text);
      if (candidate === 'CA') return /\bCanada\b/i.test(text);
      const label = regionName(candidate).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`\\b${label}\\b`, 'i').test(text);
    });
    return !mentioned.length || mentioned.includes(code);
  });
}

function countryVariants(company) {
  const countryCodes = [...new Set([
    ...company.contact.phones.flatMap((phone) => phone.countries || []),
    ...company.contact.channels.flatMap((channel) => channel.countries || []),
  ].filter(Boolean))];

  if (!countryCodes.length) return [{ ...company, country: null, countryName: '' }];
  if (countryCodes.length === 1) {
    return [{ ...company, country: countryCodes[0], countryName: regionName(countryCodes[0]) }];
  }

  const routeMatches = countryCodes.filter((code) =>
    company.contact.phones.some((phone) => phone.countries.includes(code) && samePhone(company.raw || company.phone, phone.e164 || phone.raw))
  );
  const fallbackRouteCountry = routeMatches.length ? null : countryCodes.includes('US') ? 'US' : countryCodes[0];

  return countryCodes.map((code) => {
    const phones = company.contact.phones.filter((phone) => phone.countries.includes(code));
    const channels = company.contact.channels.filter((channel) => channel.countries.includes(code));
    const keepRoute = company.steps.length > 0 && (routeMatches.includes(code) || fallbackRouteCountry === code);
    const preferred =
      phones.find((phone) => phone.deep && /customer|support|orders?|technical|consumer/i.test(phone.dept + ' ' + phone.use)) ||
      phones.find((phone) => phone.deep) ||
      phones.find((phone) => phone.official && /customer|support|orders?|technical|consumer/i.test(phone.dept + ' ' + phone.use)) ||
      phones.find((phone) => phone.official) || phones[0] || null;
    const primary = keepRoute && company.phone ? {
      phone: company.phone,
      raw: company.raw,
      dept: company.dept,
      hours: company.primaryHoursRaw,
      timezone: company.primaryHoursTimezone,
      trust: company.phoneTrust,
    } : preferred ? {
      phone: preferred.raw,
      raw: preferred.e164 || phoneDigits(preferred.raw),
      dept: preferred.dept,
      hours: preferred.hours,
      timezone: preferred.timezone,
      trust: phoneTrust(preferred.e164 || preferred.raw, phones),
    } : { phone: '', raw: '', dept: '', hours: null, timezone: null, trust: null };
    const countryNumbers = new Set(phones.map((phone) => phoneDigits(phone.e164 || phone.raw)).filter(Boolean));

    return {
      ...company,
      slug: `${company.slug}-${code.toLowerCase()}`,
      baseSlug: company.slug,
      country: code,
      countryName: regionName(code),
      phone: primary.phone,
      raw: primary.raw,
      dept: primary.dept,
      phoneTrust: primary.trust,
      steps: keepRoute ? company.steps : [],
      walk: keepRoute ? company.walk : 0,
      hold: keepRoute ? company.hold : null,
      total: keepRoute ? company.total : null,
      holdLow: keepRoute ? company.holdLow : null,
      holdHigh: keepRoute ? company.holdHigh : null,
      quiet: keepRoute ? company.quiet : '',
      hours: keepRoute ? company.hours : null,
      primaryHoursRaw: primary.hours || null,
      primaryHoursTimezone: primary.timezone || null,
      numbers: company.numbers.filter((number) => countryNumbers.has(phoneDigits(number.n || number.p))),
      alts: keepRoute ? company.alts.filter((alt) => !alt.phone || countryNumbers.has(phoneDigits(alt.phone))) : [],
      contact: {
        ...company.contact,
        phones,
        channels,
        websites: [],
        emails: [],
        addresses: [],
        routingNotes: notesForCountry(company.contact.routingNotes, code, countryCodes, company.contact.phones),
        gaps: notesForCountry(company.contact.gaps, code, countryCodes, company.contact.phones),
      },
      sources: keepRoute ? company.sources : [],
      src: keepRoute ? company.src : '',
      url: keepRoute ? company.url : '',
      confidence: keepRoute ? company.confidence : 'low',
    };
  });
}

const reservedBaseSlugs = new Set(companies.map((company) => company.slug));
const usedListingSlugs = new Set();
const listings = [];
for (const company of companies) {
  for (const listing of countryVariants(company)) {
    if (listing.baseSlug) {
      const desired = listing.slug;
      let candidate = desired;
      let suffix = 2;
      if (reservedBaseSlugs.has(candidate) || usedListingSlugs.has(candidate)) candidate = `${desired}-country`;
      while (reservedBaseSlugs.has(candidate) || usedListingSlugs.has(candidate)) candidate = `${desired}-country-${suffix++}`;
      listing.slug = candidate;
    }
    if (usedListingSlugs.has(listing.slug)) throw new Error(`Duplicate listing slug: ${listing.slug}`);
    usedListingSlugs.add(listing.slug);
    const aggregate = routeStats.get(listing.slug);
    if (aggregate && aggregate.up + aggregate.down > 0) {
      listing.votes = {
        up: aggregate.up,
        down: aggregate.down,
        lastConfirmedDay: aggregate.lastConfirmedDay,
        medianSeconds: aggregate.medianSeconds,
        stale: aggregate.stale,
      };
    }
    listings.push(listing);
  }
}

// routes we can actually walk someone through come first
listings.sort((a, b) => {
  const s = (x) => (x.steps.length ? 2 : 0) + (x.phone ? 1 : 0);
  if (s(b) !== s(a)) return s(b) - s(a);
  return (a.total == null ? 1e9 : a.total) - (b.total == null ? 1e9 : b.total);
});

/* ---------- write ---------- */

fs.mkdirSync(path.join(OUT, 'r'), { recursive: true });

const idx = listings.map((c) => ({
  s: c.slug,
  n: c.name,
  p: c.phone,
  t: c.total,
  w: c.walk,
  k: c.steps.length,
  h: c.hours ? (c.hours.always ? 2 : 1) : 0,
  cp: c.contact.phones.length,
  cc: c.contact.channels.length,
  d: c.contact.deepReviewed ? 1 : 0,
  o: c.contact.phones.filter((phone) => phone.official).length,
  ct: c.country || '',
}));
fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(idx));

const shards = {};
for (const c of listings) {
  const k = /^[a-z]/.test(c.slug) ? c.slug[0] : '_';
  if (!shards[k]) shards[k] = {};
  shards[k][c.slug] = c;
}
for (const [k, v] of Object.entries(shards)) {
  fs.writeFileSync(path.join(OUT, 'r', k + '.json'), JSON.stringify(v));
}

const withSteps = companies.filter((c) => c.steps.length).length;
const verified = companies.filter((c) => c.steps.length >= 2).length;
const medians = companies.map((c) => c.total).filter(Boolean).sort((a, b) => a - b);
const contactNumbers = companies.reduce((sum, c) => sum + c.contact.phones.length, 0);
const contactChannels = companies.reduce((sum, c) => sum + c.contact.channels.length, 0);
const deepReviewed = companies.filter((c) => c.contact.deepReviewed).length;
const countries = new Set(companies.flatMap((c) => c.contact.phones.flatMap((phone) => (phone.countries || []).filter((code) => code !== 'INTL')))).size;

fs.writeFileSync(
  path.join(OUT, 'stats.json'),
  JSON.stringify({
    companies: companies.length,
    numbers: contactNumbers,
    countries,
    contactChannels,
    deepReviewed,
    routes: coverage.master.total_routes,
    withSteps,
    verified,
    medianTotal: medians[Math.floor(medians.length / 2)] || 0,
    sources: Object.keys(coverage).filter((k) => k !== 'master' && k !== 'notes').length,
    built: new Date().toISOString().slice(0, 10),
  })
);

console.log('companies', companies.length, '| country listings', listings.length, '| with steps', withSteps, '| shards', Object.keys(shards).length);
console.log('index.json', (fs.statSync(path.join(OUT, 'index.json')).size / 1024).toFixed(0) + 'kb');
