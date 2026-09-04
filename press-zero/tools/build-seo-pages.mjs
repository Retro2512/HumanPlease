import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const companyRoot = path.join(root, 'company');
const directoryRoot = path.join(root, 'companies');
const index = JSON.parse(fs.readFileSync(path.join(root, 'data', 'index.json'), 'utf8'));
const stats = JSON.parse(fs.readFileSync(path.join(root, 'data', 'stats.json'), 'utf8'));

const esc = (value) => String(value ?? '').replace(/[<>&"]/g, (c) => ({
  '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;',
}[c]));

const human = (seconds) => {
  if (seconds == null) return '';
  if (seconds < 60) return `${seconds} seconds`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${hours} ${hours === 1 ? 'hour' : 'hours'}${rest ? ` ${rest} min` : ''}`;
};

const telHref = (value, country) => {
  const raw = String(value || '').trim();
  const expanded = [...raw.matchAll(/\(([^)]+)\)/g)]
    .map((match) => match[1].replace(/\D/g, ''))
    .findLast((digits) => digits.length >= 7 && digits.length <= 15);
  const keypad = { A: 2, B: 2, C: 2, D: 3, E: 3, F: 3, G: 4, H: 4, I: 4,
    J: 5, K: 5, L: 5, M: 6, N: 6, O: 6, P: 7, Q: 7, R: 7, S: 7,
    T: 8, U: 8, V: 8, W: 9, X: 9, Y: 9, Z: 9 };
  const digits = expanded || raw.split(/\b(?:ext(?:ension)?|x)\b/i, 1)[0].toUpperCase()
    .replace(/[A-Z]/g, (letter) => keypad[letter]).replace(/\D/g, '');
  if (!digits) return '';
  if (raw.startsWith('+')) return digits.length >= 8 && digits.length <= 15 ? `tel:+${digits}` : '';
  if (country && country !== 'US' && country !== 'CA') {
    return country === 'INTL' || digits.length < 3 ? '' : `tel:${digits}`;
  }
  if (digits.length === 11 && digits[0] === '1') return `tel:+${digits}`;
  if (digits.length === 10) return `tel:+1${digits}`;
  return `tel:${digits}`;
};

const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
const regionName = (code) => {
  if (code === 'INTL') return 'International';
  try { return code ? regionNames.of(code) || code : ''; }
  catch { return code || ''; }
};

const stepText = (step) => {
  if (step.kind === 'press') return `Press ${step.key}${step.note ? ` — ${step.note}` : ''}`;
  if (step.kind === 'say') return `Say “${step.key}”${step.note ? ` — ${step.note}` : ''}`;
  if (step.kind === 'enter') return `Enter ${step.key}${step.note ? ` — ${step.note}` : ''}`;
  return step.note || step.key || 'Wait for the next prompt';
};

const shell = ({ title, description, canonical, robots = 'index,follow', body, script = '' }) => `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta name="robots" content="${robots}">
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(canonical)}">
<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#0e0e12" media="(prefers-color-scheme: dark)">
<link rel="stylesheet" href="../../assets/fonts.css?v=20260903-route-rework-5">
<link rel="stylesheet" href="../../assets/base.css?v=20260903-route-rework-5">
<link rel="stylesheet" href="../../assets/flags.css?v=20260903-route-rework-5">
</head><body>
<div class="sheet" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
<div class="rails" aria-hidden="true"><div class="wrap"><i></i><i></i></div></div>
<header class="bar"><div class="wrap"><a class="mark" href="../../">Human<em>,</em> Please</a><span class="grow"></span><a class="back mono" href="../../"><span class="arw">&larr;</span> Search again</a></div></header>
${body}
${script}
</body></html>`;

const shardCache = new Map();
const getCompany = (slug) => {
  const shard = /^[a-z]/.test(slug) ? slug[0] : '_';
  if (!shardCache.has(shard)) {
    shardCache.set(shard, JSON.parse(fs.readFileSync(path.join(root, 'data', 'r', `${shard}.json`), 'utf8')));
  }
  return shardCache.get(shard)[slug];
};

fs.rmSync(companyRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
fs.mkdirSync(companyRoot, { recursive: true });
let mapped = 0;
let indexable = 0;
const legacyAliases = new Map();

for (const item of index) {
  const c = getCompany(item.s);
  if (!c) throw new Error(`Missing route data for ${item.s}`);

  const hasRoute = c.steps.length > 0;
  const displayName = c.countryName ? `${c.name} ${c.countryName}` : c.name;
  if (c.baseSlug) {
    const priority = c.country === 'CA' ? 0 : c.country === 'US' ? 1 : 2;
    const current = legacyAliases.get(c.baseSlug);
    if (!current || priority < current.priority) legacyAliases.set(c.baseSlug, { slug: c.slug, name: displayName, priority });
  }
  const canIndex = hasRoute || c.contact?.deepReviewed || c.contact?.phones?.some((phone) => phone.official);
  if (hasRoute) mapped++;
  if (canIndex) indexable++;
  const trustedPhone = c.phoneTrust === 'official' || c.phoneTrust === 'corroborated';
  const route = hasRoute
    ? `<section class="sec"><header><h2>The route</h2><span class="mono n">${c.steps.length} ${c.steps.length === 1 ? 'step' : 'steps'}</span></header><ol>${c.steps.map((s) => `<li>${esc(stepText(s))}</li>`).join('')}</ol></section>`
    : `<section class="sec"><header><h2>The route</h2></header><p>No company-specific menu steps are on file yet.</p></section>`;
  const time = c.total != null ? `<p class="fact">About <b>${esc(human(c.total))}</b> from dial tone to a person.</p>` : '';
  const description = hasRoute && trustedPhone
    ? `Call ${displayName} at ${c.phone}. Follow ${c.steps.length} ${c.steps.length === 1 ? 'step' : 'steps'} to reach a person${c.total != null ? ` in about ${human(c.total)}` : ''}.`
    : c.phone
      ? `Phone numbers and official contact options on file for ${displayName}, including published hours and department details when available.`
      : `Official online contact options and available support details for ${displayName}.`;
  const canonical = `https://humanplease.wiki/company/${encodeURIComponent(c.slug)}/`;
  const dialHref = c.phone && trustedPhone ? telHref(c.raw || c.phone, c.country) : '';
  const dial = c.phone
    ? dialHref
      ? `<a class="dial" href="${esc(dialHref)}"><span class="num">${esc(c.phone)}</span><span class="go" aria-hidden="true">&#8599;</span><span class="ul"></span></a>`
      : `<span class="dial nolink"><span class="num">${esc(c.phone)}</span></span>`
    : '';
  const sub = c.country
    ? `<p class="sub countryline"><img class="flagicon" src="../../assets/flags/${esc(c.country.toLowerCase())}.svg" alt=""> ${esc(c.countryName || regionName(c.country))}${c.dept ? ` &middot; ${esc(c.dept[0].toUpperCase() + c.dept.slice(1))} line` : ''}</p>`
    : c.dept ? `<p class="sub">${esc(c.dept[0].toUpperCase() + c.dept.slice(1))} line</p>` : '';
  const trust = c.phone
    ? `<p class="fact">${c.phoneTrust === 'official' ? 'Official source' : c.phoneTrust === 'corroborated' ? 'Matched by multiple sources' : 'Not independently verified'}</p>`
    : '';
  const body = `<main id="page" class="wrap"><section class="head"><h1 class="co">${esc(c.name)}</h1>${sub}${dial}${trust}${time}</section>${route}</main>`;
  const html = shell({
    title: `${displayName} customer service: phone number and route — Human, Please`,
    description,
    canonical,
    robots: canIndex ? 'index,follow' : 'noindex,follow',
    body,
    script: '<script src="../../assets/core.js?v=20260903-route-rework-5"></script>' +
      '<script src="../../assets/company-page.js?v=20260903-route-rework-5"></script>',
  });
  const out = path.join(companyRoot, c.slug);
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'index.html'), html);
}

for (const [baseSlug, target] of legacyAliases) {
  const href = `../${encodeURIComponent(target.slug)}/`;
  const canonical = `https://humanplease.wiki/company/${encodeURIComponent(target.slug)}/`;
  const out = path.join(companyRoot, baseSlug);
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'index.html'), shell({
    title: `${target.name} customer service — Human, Please`,
    description: `Continue to the country-specific customer-service page for ${target.name}.`,
    canonical,
    robots: 'noindex,follow',
    body: `<main class="wrap"><section class="head"><h1 class="co">Choose your country</h1><p class="sub"><a href="${href}">Continue to ${esc(target.name)}</a></p></section></main>`,
  }));
}

const groups = new Map();
for (const item of index) {
  const letter = /^[a-z]/i.test(item.n) ? item.n[0].toUpperCase() : '#';
  if (!groups.has(letter)) groups.set(letter, []);
  groups.get(letter).push(item);
}
const directoryBody = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([letter, items]) =>
  `<section class="sec"><header><h2>${esc(letter)}</h2><span class="mono n">${items.length}</span></header><ul>${items.map((item) => {
    const detail = item.k
      ? `${item.k} ${item.k === 1 ? 'step' : 'steps'}`
      : item.cp
        ? `${item.cp} ${item.cp === 1 ? 'phone' : 'phones'}`
        : item.cc
          ? `${item.cc} online ${item.cc === 1 ? 'contact' : 'contacts'}`
          : '';
    return `<li><a href="../company/${encodeURIComponent(item.s)}/">${esc(item.n)}</a>${item.ct ? ` <img class="countryflag" src="../assets/flags/${esc(item.ct.toLowerCase())}.svg" alt="${esc(regionName(item.ct))}" title="${esc(regionName(item.ct))}">` : ''}${detail ? ` <span class="mono">${detail}</span>` : ''}${item.d ? ' <span class="mono">researched</span>' : ''}</li>`;
  }).join('')}</ul></section>`
).join('');
fs.mkdirSync(directoryRoot, { recursive: true });
fs.writeFileSync(path.join(directoryRoot, 'index.html'), shell({
  title: 'Company phone routes — Human, Please',
  description: `Browse phone numbers, online contact options and mapped keypad routes for ${stats.companies.toLocaleString('en-US')} companies and services across ${index.length.toLocaleString('en-US')} country listings.`,
  canonical: 'https://humanplease.wiki/companies/',
  body: `<main class="wrap"><section class="head"><h1 class="co">All companies</h1><p class="sub">${stats.companies.toLocaleString('en-US')} companies and services · ${index.length.toLocaleString('en-US')} country listings · ${mapped.toLocaleString('en-US')} mapped menus</p></section>${directoryBody}</main>`,
}));

console.log(`wrote ${index.length} country-aware company pages and ${legacyAliases.size} legacy redirects (${indexable} indexable, ${mapped} mapped menus)`);
