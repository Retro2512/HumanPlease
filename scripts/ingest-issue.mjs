import { access, appendFile, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {
  addTimingSample,
  archiveRelativePath,
  catalogFor,
  chooseFrontRoute,
  createStoredRoute,
  currentRelativePath,
  findJsonFiles,
  loadRepositoryRoutes,
  normalizeSubmission,
  readRoute,
  routeId,
  validateStoredRoute,
  validateSubmission,
} from './lib/route.mjs';

const root = process.cwd();
const eventPath = process.argv[2];
const outputPath = process.env.GITHUB_OUTPUT;

async function output(name, value) {
  if (!outputPath) return;
  const safe = String(value).replace(/[\r\n]+/g, ' ').slice(0, 500);
  await appendFile(outputPath, `${name}=${safe}\n`);
}

async function finish(status, values = {}) {
  await output('status', status);
  for (const [name, value] of Object.entries(values)) await output(name, value);
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function writeRoute(relative, route) {
  const file = path.join(root, ...relative.split('/'));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(route, null, 2)}\n`);
}

async function rebuildCatalogs() {
  const { active, archived } = await loadRepositoryRoutes(root);
  await writeFile(path.join(root, 'catalog.json'), `${JSON.stringify(catalogFor(active), null, 2)}\n`);
  await mkdir(path.join(root, 'archive'), { recursive: true });
  await writeFile(path.join(root, 'archive', 'catalog.json'), `${JSON.stringify(catalogFor(archived, true), null, 2)}\n`);
}

try {
  if (!eventPath) throw new Error('event payload is missing');
  const event = JSON.parse(await readFile(eventPath, 'utf8'));
  const body = event.issue?.body ?? '';
  const match = body.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (!match) throw new Error('include the route in one fenced JSON block');

  const submission = normalizeSubmission(JSON.parse(match[1]));
  const submissionErrors = validateSubmission(submission);
  if (submissionErrors.length) throw new Error(submissionErrors[0]);

  const currentFile = path.join(root, ...currentRelativePath(submission).split('/'));
  const archiveDirectory = path.join(root, 'archive', submission.site, submission.locale);
  const groupFiles = [
    ...((await exists(currentFile)) ? [currentFile] : []),
    ...(await findJsonFiles(archiveDirectory)),
  ];
  const routes = [];
  let currentId = null;
  for (const file of groupFiles) {
    const route = await readRoute(file);
    const errors = validateStoredRoute(route);
    if (errors.length) throw new Error(`${path.relative(root, file)}: ${errors[0]}`);
    routes.push(route);
    if (file === currentFile) currentId = route.id;
  }

  const id = routeId(submission);
  const existingIndex = routes.findIndex((route) => route.id === id);
  const status = existingIndex >= 0 ? 'updated' : 'created';
  if (existingIndex >= 0) {
    routes[existingIndex] = addTimingSample(routes[existingIndex], submission.handoffSeconds, submission.verifiedOn);
  } else {
    routes.push(createStoredRoute(submission));
  }

  const front = chooseFrontRoute(routes, currentId);
  const promoted = front.id !== currentId;
  for (const file of groupFiles) await unlink(file);
  for (const route of routes) {
    await writeRoute(route.id === front.id ? currentRelativePath(route) : archiveRelativePath(route), route);
  }
  await rebuildCatalogs();
  await finish(status, {
    site: submission.site,
    locale: submission.locale,
    route_id: id,
    position: id === front.id ? 'front' : 'archive',
    promoted,
    score_seconds: routes.find((route) => route.id === id).timing.scoreSeconds,
  });
} catch {
  await finish('invalid');
}
