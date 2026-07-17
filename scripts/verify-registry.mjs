#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from './verify-registry-core.js';

export { computeBadge, parseArgs, verifyEntries, writeBadgeFiles } from './verify-registry-core.js';

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
