#!/usr/bin/env node
// Best-effort static scan of a template's script source for the most common ways a
// script could try to exfiltrate data or read cookies off-page: fetch/XHR/WebSocket/
// sendBeacon calls, and non-relative document.cookie writes. This is NOT the real
// security gate - it's a source-text regex scan, trivially evaded by obfuscation
// (e.g. window['fe'+'tch']). The real backstop is the live behavioral check in
// verify-registry.mjs, which observes actual runtime network requests regardless of
// how the source is written. Use this as a fast, cheap first pass in CI - a template
// that fails this is almost certainly doing something worth a human look; passing
// this proves nothing on its own.
import { readFile } from 'node:fs/promises';

const PATTERNS = [
  { name: 'fetch(', regex: /\bfetch\s*\(/ },
  { name: 'XMLHttpRequest', regex: /\bnew\s+XMLHttpRequest\b/ },
  { name: 'WebSocket', regex: /\bnew\s+WebSocket\b/ },
  { name: 'navigator.sendBeacon', regex: /\bnavigator\s*\.\s*sendBeacon\b/ },
  { name: 'document.cookie write', regex: /\bdocument\s*\.\s*cookie\s*=/ },
];

async function lintFile(filePath) {
  const source = await readFile(filePath, 'utf8');
  const hits = [];
  for (const { name, regex } of PATTERNS) {
    if (regex.test(source)) hits.push(name);
  }
  return hits;
}

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error('Usage: node scripts/lint-template.mjs <path-to-template.js>');
    process.exit(1);
  }
  const hits = await lintFile(filePath);
  if (hits.length === 0) {
    console.log(`OK: ${filePath} - no flagged patterns found (see script header - this is not a guarantee).`);
    process.exitCode = 0;
  } else {
    console.log(`FLAGGED: ${filePath} - contains: ${hits.join(', ')}`);
    console.log('Not necessarily malicious (a template MAY legitimately need fetch() to hit its own domain\'s JSON API), but review before merging - and rely on verify-registry.mjs\'s live behavioral check as the real gate, not this scan alone.');
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
