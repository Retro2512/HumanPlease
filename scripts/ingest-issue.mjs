import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { catalogFor, findJsonFiles, normalizeRoute, readRoute, routeRelativePath, validateRoute } from './lib/route.mjs';

const root = process.cwd();
const eventPath = process.argv[2];
const outputPath = process.env.GITHUB_OUTPUT;

function output(name, value) {
  if (!outputPath) return;
  const safe = String(value).replace(/[\r\n]+/g, ' ').slice(0, 500);
  return import('node:fs/promises').then(({ appendFile }) => appendFile(outputPath, `${name}=${safe}\n`));
}

async function finish(status, values = {}) {
  await output('status', status);
  for (const [name, value] of Object.entries(values)) await output(name, value);
}

try {
  if (!eventPath) throw new Error('event payload is missing');
  const event = JSON.parse(await readFile(eventPath, 'utf8'));
  const body = event.issue?.body ?? '';
  const match = body.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (!match) throw new Error('include the route in one fenced JSON block');

  const raw = JSON.parse(match[1]);
  const route = normalizeRoute(raw);
  const errors = validateRoute(route);
  if (errors.length) throw new Error(errors[0]);

  const relativePath = routeRelativePath(route);
  const file = path.join(root, ...relativePath.split('/'));
  try {
    await access(file);
    await finish('duplicate', { site: route.site, locale: route.locale });
    process.exit(0);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(route, null, 2)}\n`);

  const entries = [];
  for (const routeFile of await findJsonFiles(path.join(root, 'routes'))) {
    const saved = await readRoute(routeFile);
    const savedErrors = validateRoute(saved);
    if (savedErrors.length) throw new Error(`${routeFile}: ${savedErrors[0]}`);
    entries.push({ route: saved, relativePath: path.relative(root, routeFile) });
  }
  await writeFile(path.join(root, 'catalog.json'), `${JSON.stringify(catalogFor(entries), null, 2)}\n`);
  await finish('created', { site: route.site, locale: route.locale, path: relativePath });
} catch (error) {
  await finish('invalid', { message: error.message });
}
