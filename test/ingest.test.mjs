import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const run = promisify(execFile);
const script = path.resolve('scripts/ingest-issue.mjs');

function submission(startPath, handoffSeconds) {
  return {
    schemaVersion: 2,
    site: 'shop.example.com',
    locale: 'en-CA',
    startPath,
    steps: [
      { action: 'open_chat', label: 'Chat with us' },
      { action: 'send', value: 'live agent' },
      { action: 'wait_for_human' },
    ],
    verifiedOn: '2026-08-24',
    handoffSeconds,
  };
}

async function ingest(root, route, sequence) {
  const fence = '`'.repeat(3);
  const event = { issue: { body: `### Route JSON\n\n${fence}json\n${JSON.stringify(route)}\n${fence}` } };
  const eventPath = path.join(root, `event-${sequence}.json`);
  const outputPath = path.join(root, `output-${sequence}.txt`);
  await writeFile(eventPath, JSON.stringify(event));
  await run(process.execPath, [script, eventPath], {
    cwd: root,
    env: { ...process.env, GITHUB_OUTPUT: outputPath },
  });
  return readFile(outputPath, 'utf8');
}

test('intake promotes a proven faster route and archives the former winner', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'humanplease-ranking-'));
  try {
    await mkdir(path.join(root, 'routes'));
    await mkdir(path.join(root, 'archive'));
    await writeFile(path.join(root, 'catalog.json'), '{"schemaVersion":2,"kind":"fastest","routes":[]}\n');
    await writeFile(path.join(root, 'archive', 'catalog.json'), '{"schemaVersion":2,"kind":"archive","routes":[]}\n');

    const first = await ingest(root, submission('/support', 120), 1);
    assert.match(first, /position=front/);
    await ingest(root, submission('/contact', 50), 2);
    await ingest(root, submission('/contact', 52), 3);
    const promoted = await ingest(root, submission('/contact', 51), 4);
    assert.match(promoted, /position=front/);
    assert.match(promoted, /promoted=true/);

    const current = JSON.parse(await readFile(
      path.join(root, 'routes', 'shop.example.com', 'en-CA', 'current.json'), 'utf8',
    ));
    assert.equal(current.startPath, '/contact');
    assert.deepEqual(current.timing.samplesSeconds, [50, 52, 51]);

    const archiveCatalog = JSON.parse(await readFile(path.join(root, 'archive', 'catalog.json'), 'utf8'));
    assert.equal(archiveCatalog.routes.length, 1);
    assert.equal(archiveCatalog.routes[0].startPath, '/support');
    const frontCatalog = JSON.parse(await readFile(path.join(root, 'catalog.json'), 'utf8'));
    assert.equal(frontCatalog.routes.length, 1);
    assert.equal(frontCatalog.routes[0].startPath, '/contact');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('invalid issue content is not echoed into privileged workflow output', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'humanplease-invalid-'));
  try {
    const output = await ingest(root, { site: '@target-user malicious content' }, 1);
    assert.equal(output, 'status=invalid\n');
    assert.doesNotMatch(output, /target-user|malicious/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
