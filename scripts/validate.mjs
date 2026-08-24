import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { catalogFor, findJsonFiles, readRoute, routeFingerprint, routeRelativePath, validateRoute } from './lib/route.mjs';

const root = process.cwd();
const explicit = process.argv.slice(2);
const files = explicit.length ? explicit.map((file) => path.resolve(file)) : await findJsonFiles(path.join(root, 'routes'));
const entries = [];
const fingerprints = new Map();
let failed = false;

for (const file of files) {
  try {
    const route = await readRoute(file);
    const errors = validateRoute(route);
    const relative = path.relative(root, file).replaceAll('\\', '/');
    if (errors.length) {
      failed = true;
      for (const error of errors) console.error(`${relative}: ${error}`);
      continue;
    }

    const fingerprint = routeFingerprint(route);
    if (fingerprints.has(fingerprint)) {
      failed = true;
      console.error(`${relative}: exact duplicate of ${fingerprints.get(fingerprint)}`);
    } else {
      fingerprints.set(fingerprint, relative);
    }

    if (!explicit.length && relative !== routeRelativePath(route)) {
      failed = true;
      console.error(`${relative}: expected path ${routeRelativePath(route)}`);
    }
    entries.push({ route, relativePath: relative });
  } catch (error) {
    failed = true;
    console.error(`${file}: ${error.message}`);
  }
}

if (!explicit.length) {
  const expected = `${JSON.stringify(catalogFor(entries), null, 2)}\n`;
  const actual = await readFile(path.join(root, 'catalog.json'), 'utf8');
  if (actual !== expected) {
    failed = true;
    console.error('catalog.json is out of date; run npm run catalog');
  }
}

if (failed) process.exit(1);
console.log(`Validated ${files.length} route${files.length === 1 ? '' : 's'}.`);

