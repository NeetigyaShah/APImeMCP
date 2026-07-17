#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { lintManifestEntry } from '../dist/registry-lint.js';

async function main() {
  const templatesDir = path.resolve(process.argv[2] ?? 'templates');
  const manifestPath = path.join(templatesDir, 'manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      console.log(`No local templates manifest at ${manifestPath}; nothing to lint.`);
      return;
    }
    throw error;
  }

  let failed = false;
  for (const entry of Object.values(manifest)) {
    let script = '';
    try {
      script = await readFile(path.resolve(templatesDir, path.basename(entry.scriptPath)), 'utf8');
    } catch (error) {
      console.error(`${entry.templateId}: unable to read script: ${error instanceof Error ? error.message : String(error)}`);
      failed = true;
      continue;
    }
    const result = lintManifestEntry(entry, script);
    for (const warning of result.warnings) console.warn(`${result.templateId}: warning: ${warning}`);
    for (const error of result.errors) console.error(`${result.templateId}: error: ${error}`);
    failed ||= result.errors.length > 0;
  }
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
