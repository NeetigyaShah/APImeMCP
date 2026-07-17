import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initBrowser, closeBrowser, executeExtraction } from '../dist/engine.js';
import { atomicWriteFile } from '../dist/storage.js';
import { computeBadge, verifyEntries, writeBadgeFiles } from './verify-registry.mjs';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const goodHtml = await fs.readFile(path.join(fixturesDir, 'f03-good.html'));
const brokenHtml = await fs.readFile(path.join(fixturesDir, 'f03-broken.html'));
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'apimemcp-verify-f03-'));
const outDir = path.join(tempDir, 'badges');
const server = createServer((request, response) => {
  const body = request.url === '/good' ? goodHtml : request.url === '/broken' ? brokenHtml : undefined;
  if (!body) return response.writeHead(404).end();
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(body);
});

try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture server did not expose a TCP port');
  const urls = { good: `http://127.0.0.1:${address.port}/good`, broken: `http://127.0.0.1:${address.port}/broken` };
  const manifest = {
    good: { templateId: 'good', domainPattern: '127.0.0.1', fixedTargetUrl: urls.good },
    broken: { templateId: 'broken', domainPattern: '127.0.0.1', fixedTargetUrl: urls.broken },
    input: { templateId: 'input', domainPattern: '127.0.0.1' },
  };
  const sources = {
    good: '() => document.querySelector("#value").textContent',
    broken: '() => document.querySelector("#value").textContent',
  };
  await initBrowser();
  const records = await verifyEntries(manifest, {
    runEntry: async (templateId, entry) => {
      const scriptPath = path.join(tempDir, `${templateId}.js`);
      await atomicWriteFile(scriptPath, sources[templateId]);
      await executeExtraction({ targetUrl: entry.fixedTargetUrl, scriptPath });
    },
  });
  await writeBadgeFiles(records, { out: outDir, dryRun: false, atomicWriteFile });
  const goodBadge = JSON.parse(await fs.readFile(path.join(outDir, 'good.json'), 'utf8'));
  const brokenBadge = JSON.parse(await fs.readFile(path.join(outDir, 'broken.json'), 'utf8'));
  const inputBadge = JSON.parse(await fs.readFile(path.join(outDir, 'input.json'), 'utf8'));
  if (goodBadge.message !== 'passing' || goodBadge.color !== 'brightgreen') throw new Error(`Good fixture did not pass: ${JSON.stringify(records)}`);
  if (brokenBadge.message !== 'failing' || brokenBadge.color !== 'red' || !records.find((record) => record.templateId === 'broken')?.error) throw new Error('Broken fixture did not fail with an error');
  if (inputBadge.message !== 'unverified' || inputBadge.color !== 'lightgrey') throw new Error('Input fixture was not unverified');
  await writeBadgeFiles(records, { out: path.join(tempDir, 'dry-run'), dryRun: true, atomicWriteFile });
  await fs.access(path.join(tempDir, 'dry-run', 'good.json')).then(() => { throw new Error('Dry run wrote a badge'); }, (error) => { if (error.code !== 'ENOENT') throw error; });
  console.log('F03 registry verification passed');
} finally {
  await closeBrowser();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(tempDir, { recursive: true, force: true });
}
