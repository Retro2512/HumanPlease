import { readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const companyDirectory = path.join(root, 'press-zero', 'company');
const outputPath = path.join(root, 'data', 'slug_manifest.json');
const slugPattern = /^[a-z0-9][a-z0-9-]{0,80}$/;

const entries = await readdir(companyDirectory, { withFileTypes: true });
const slugs = entries
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort((left, right) => left.localeCompare(right));

const invalid = slugs.filter((slug) => !slugPattern.test(slug));
if (invalid.length) {
  throw new Error(`Invalid company slug${invalid.length === 1 ? '' : 's'}: ${invalid.slice(0, 10).join(', ')}`);
}

const manifest = { schemaVersion: 1, slugs };
await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Wrote ${slugs.length} slugs to ${path.relative(root, outputPath)}.`);
