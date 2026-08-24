import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { catalogFor, loadRepositoryRoutes, validateStoredRoute } from './lib/route.mjs';

const root = process.cwd();
await mkdir(path.join(root, 'routes'), { recursive: true });
await mkdir(path.join(root, 'archive'), { recursive: true });
const { active, archived } = await loadRepositoryRoutes(root);
for (const entry of [...active, ...archived]) {
  const errors = validateStoredRoute(entry.route);
  if (errors.length) throw new Error(`${entry.relativePath}: ${errors.join('; ')}`);
}
await writeFile(path.join(root, 'catalog.json'), `${JSON.stringify(catalogFor(active), null, 2)}\n`);
await writeFile(path.join(root, 'archive', 'catalog.json'), `${JSON.stringify(catalogFor(archived, true), null, 2)}\n`);
console.log(`Catalog contains ${active.length} fastest route${active.length === 1 ? '' : 's'} and ${archived.length} archived route${archived.length === 1 ? '' : 's'}.`);

