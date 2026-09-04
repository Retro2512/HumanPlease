import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const serviceDirectory = path.join(root, 'services', 'reports');
const executable = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const args = [
  'wrangler',
  'kv',
  'key',
  'put',
  'manifest:v1',
  '--binding',
  'REPORTS_KV',
  '--path',
  '../../data/slug_manifest.json',
  '--remote',
];

const child = spawn(executable, args, { cwd: serviceDirectory, stdio: 'inherit' });
child.on('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
