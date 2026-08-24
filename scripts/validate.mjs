import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {
  archiveRelativePath, catalogFor, chooseFrontRoute, currentRelativePath,
  loadRepositoryRoutes, readRoute, validateStoredRoute, validateSubmission,
} from './lib/route.mjs';

const root = process.cwd();
const explicit = process.argv.slice(2);
let failed = false;

if (explicit.length) {
  for (const name of explicit) {
    try {
      const value = await readRoute(path.resolve(name));
      const errors = 'handoffSeconds' in value ? validateSubmission(value) : validateStoredRoute(value);
      if (errors.length) {
        failed = true;
        for (const error of errors) console.error(`${name}: ${error}`);
      }
    } catch (error) {
      failed = true;
      console.error(`${name}: ${error.message}`);
    }
  }
  if (failed) process.exit(1);
  console.log(`Validated ${explicit.length} file${explicit.length === 1 ? '' : 's'}.`);
  process.exit(0);
}

const { active, archived } = await loadRepositoryRoutes(root);
const all = [...active, ...archived];
const ids = new Map();
const groups = new Map();
for (const entry of all) {
  const relative = entry.relativePath.replaceAll('\\', '/');
  for (const error of validateStoredRoute(entry.route)) {
    failed = true;
    console.error(`${relative}: ${error}`);
  }
  if (ids.has(entry.route.id)) {
    failed = true;
    console.error(`${relative}: duplicate route ID also found at ${ids.get(entry.route.id)}`);
  } else ids.set(entry.route.id, relative);
  const isActive = active.includes(entry);
  const expected = isActive ? currentRelativePath(entry.route) : archiveRelativePath(entry.route);
  if (relative !== expected) {
    failed = true;
    console.error(`${relative}: expected path ${expected}`);
  }
  const key = `${entry.route.site}\0${entry.route.locale}`;
  const group = groups.get(key) ?? { active: [], archived: [] };
  group[isActive ? 'active' : 'archived'].push(entry.route);
  groups.set(key, group);
}

for (const [key, group] of groups) {
  if (group.active.length !== 1) {
    failed = true;
    console.error(`${key.replace('\0', ' / ')}: expected exactly one fastest route`);
    continue;
  }
  const chosen = chooseFrontRoute([...group.active, ...group.archived], group.active[0].id);
  if (chosen.id !== group.active[0].id) {
    failed = true;
    console.error(`${key.replace('\0', ' / ')}: ${chosen.id} should be promoted to the front`);
  }
}

const expectedFront = `${JSON.stringify(catalogFor(active), null, 2)}\n`;
const expectedArchive = `${JSON.stringify(catalogFor(archived, true), null, 2)}\n`;
if (await readFile(path.join(root, 'catalog.json'), 'utf8') !== expectedFront) {
  failed = true;
  console.error('catalog.json is out of date; run npm run catalog');
}
if (await readFile(path.join(root, 'archive', 'catalog.json'), 'utf8') !== expectedArchive) {
  failed = true;
  console.error('archive/catalog.json is out of date; run npm run catalog');
}
if (failed) process.exit(1);
console.log(`Validated ${active.length} fastest route${active.length === 1 ? '' : 's'} and ${archived.length} archived route${archived.length === 1 ? '' : 's'}.`);

