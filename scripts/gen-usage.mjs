#!/usr/bin/env node
// Regenerate apis/<templateId>.md for every registered template, using each
// template's most recent run URL (from the metrics CSV) as the example so the
// copy-paste console command actually fetches something real.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildUsageMarkdown } from '../dist/usage.js';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const manifestPath = path.join(root, 'templates', 'manifest.json');
const metricsPath = path.join(root, 'templates', 'extraction_metrics.csv');
const apisDir = path.join(root, 'apis');

// Minimal CSV line splitter matching src/metrics.ts's escaping (quotes doubled).
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

async function lastUrlByTemplate() {
  const map = {};
  let raw;
  try {
    raw = await fs.readFile(metricsPath, 'utf8');
  } catch {
    return map; // no runs yet
  }
  // rows are appended chronologically; later rows overwrite earlier -> last-run wins
  for (const line of raw.trim().split('\n').slice(1).filter(Boolean)) {
    const [, templateId, url] = parseCsvLine(line);
    if (templateId && url) map[templateId] = url;
  }
  return map;
}

const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
const lastUrls = await lastUrlByTemplate();
await fs.mkdir(apisDir, { recursive: true });

const entries = Object.values(manifest);
for (const entry of entries) {
  const md = buildUsageMarkdown(entry, lastUrls[entry.templateId] || entry.fixedTargetUrl);
  await fs.writeFile(path.join(apisDir, `${entry.templateId}.md`), md, 'utf8');
}

// Index so you can see every API at a glance.
const index =
  `# APImeMCP — registered APIs\n\n` +
  `One console-runnable API per registered template. See each file for exact commands.\n\n` +
  entries
    .map((e) => `- [\`${e.templateId}\`](./${e.templateId}.md) — ${e.kind === 'action-sequence' ? 'action-sequence' : 'extraction'}, \`${e.domainPattern}\``)
    .join('\n') +
  '\n';
await fs.writeFile(path.join(apisDir, 'README.md'), index, 'utf8');

console.log(`Wrote ${entries.length} usage guide(s) + index to ${apisDir}`);
