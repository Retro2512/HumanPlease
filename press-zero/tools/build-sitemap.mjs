import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const index = JSON.parse(fs.readFileSync(path.join(root, 'data', 'index.json'), 'utf8'));
const escapeXml = (value) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

const urls = [
  ['https://humanplease.wiki/', '1.0'],
  ['https://humanplease.wiki/companies/', '0.6'],
  ['https://humanplease.wiki/about.html', '0.4'],
  ...index.filter(({ k, d, o }) => k > 0 || d > 0 || o > 0).map(({ s }) => [`https://humanplease.wiki/company/${encodeURIComponent(s)}/`, '0.7']),
];

const xml = `<?xml version="1.0" encoding="UTF-8"?>\n` +
  `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
  urls.map(([loc, priority]) => `  <url><loc>${escapeXml(loc)}</loc><priority>${priority}</priority></url>`).join('\n') +
  `\n</urlset>\n`;

fs.writeFileSync(path.join(root, 'sitemap.xml'), xml);
console.log(`wrote sitemap.xml with ${urls.length} URLs`);
