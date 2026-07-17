import http from 'node:http';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const fixtureHtml = '<!doctype html><html><head><title>F05 Fixture</title></head><body>fixture</body></html>';
const fixture = http.createServer((_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end(fixtureHtml);
});

await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve));
const targetUrl = `http://127.0.0.1:${fixture.address().port}/`;
const manifestPath = path.resolve('templates/manifest.json');
let originalManifest = null;
const client = new Client({ name: 'verify-f05', version: '1.0.0' });
const transport = new StdioClientTransport({ command: process.execPath, args: ['dist/index.js'], cwd: process.cwd() });

function payload(result) {
  return JSON.parse(result.content[0].text);
}

try {
  await mkdir(path.dirname(manifestPath), { recursive: true });
  originalManifest = await readFile(manifestPath, 'utf8').catch(() => null);
  await client.connect(transport);

  const forensics = payload(await client.callTool({ name: 'synthesize_schema', arguments: { targetUrl } }));
  if (!forensics.html || !forensics.screenshotPath) throw new Error('synthesize_schema did not return HTML and screenshotPath');

  const before = await stat(manifestPath);
  const dryRun = payload(await client.callTool({ name: 'execute_native_extraction', arguments: { targetUrl, executableScript: '() => ({ title: document.title })' } }));
  const after = await stat(manifestPath);
  if (!dryRun.dryRun || dryRun.data?.title !== 'F05 Fixture') throw new Error('dry-run did not return the fixture title');
  if (before.mtimeMs !== after.mtimeMs) throw new Error('dry-run modified the manifest');

  await client.callTool({ name: 'register_extraction_template', arguments: { templateId: 'f05-fixture', domainPattern: '127.0.0.1', executableScript: '() => ({ title: document.title })' } });
  const registered = payload(await client.callTool({ name: 'execute_native_extraction', arguments: { templateId: 'f05-fixture', targetUrl } }));
  if (JSON.stringify(registered.data) !== JSON.stringify(dryRun.data)) throw new Error('registered run differs from dry-run');
  console.log('PASS');

} finally {
  await client.close().catch(() => undefined);
  fixture.close();
  if (originalManifest === null) await rm('templates', { recursive: true, force: true });
  else await writeFile(manifestPath, originalManifest);
}
