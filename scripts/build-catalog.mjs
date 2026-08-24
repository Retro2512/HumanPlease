import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { catalogFor, findJsonFiles, readRoute, validateRoute } from './lib/route.mjs';

const root = process.cwd();
const routeRoot = path.join(root, 'routes');
await mkdir(routeRoot, { recursive: true });
const entries = [];

for (const file of await findJsonFiles(routeRoot)) {
  const route = await readRoute(file);
  const errors = validateRoute(route);
  if (errors.length) throw new Error(`${file}: ${errors.join('; ')}`);
  entries.push({ route, relativePath: path.relative(root, file) });
}

await writeFile(path.join(root, 'catalog.json'), `${JSON.stringify(catalogFor(entries), null, 2)}\n`);
console.log(`Catalog contains ${entries.length} route${entries.length === 1 ? '' : 's'}.`);

