import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureV1 = await fs.readFile(path.join(here, 'fixtures', 'f23-snapshot.html'), 'utf8');
const fixtureV2 = await fs.readFile(path.join(here, 'fixtures', 'f23-snapshot-v2.html'), 'utf8');
const extractionScript = '(() => ({ name: document.querySelector("[data-name]").textContent, price: document.querySelector("[data-price]").textContent }))()';

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'apimemcp-verify-f23-'));
let fixture = fixtureV1;
const server = http.createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(fixture);
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});

const address = server.address();
if (!address || typeof address === 'string') throw new Error('Fixture server did not expose a TCP port');
const targetUrl = `http://127.0.0.1:${address.port}/`;
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))],
  cwd: tempDir,
  stderr: 'inherit',
});
const client = new Client({ name: 'verify-f23', version: '1.0.0' });

async function run(snapshot) {
  const response = await client.callTool({ name: 'execute_native_extraction', arguments: { templateId: 'f23-fixture', targetUrl, snapshot } });
  return JSON.parse(response.content[0].text);
}

try {
  await client.connect(transport);
  await client.callTool({
    name: 'register_extraction_template',
    arguments: { templateId: 'f23-fixture', domainPattern: '127.0.0.1', executableScript: extractionScript },
  });

  const recorded = await run('record');
  const snapshotFile = path.join(tempDir, 'templates', 'snapshots', 'f23-fixture.json');
  await fs.access(snapshotFile);
  if (!recorded.snapshotRecorded) throw new Error('record did not return snapshotRecorded');
  console.log('PASS record');

  if ((await run('check')).snapshotCheck?.status !== 'match') throw new Error('unchanged output did not match');
  console.log('PASS match');

  fixture = fixtureV2;
  const regression = (await run('check')).snapshotCheck;
  if (regression?.status !== 'regression' || !regression.diff.some(({ path: diffPath }) => diffPath === 'price')) {
    throw new Error(`expected a price regression, got ${JSON.stringify(regression)}`);
  }
  console.log('PASS regression-detected price');

  if ((await run('record')).snapshotRecorded?.data?.price !== '12.00') throw new Error('re-record did not capture mutated output');
  if ((await run('check')).snapshotCheck?.status !== 'match') throw new Error('re-recorded output did not match');
  console.log('PASS re-record-match');

  const off = await run('off');
  if ('snapshotRecorded' in off || 'snapshotCheck' in off) throw new Error('off mode returned snapshot fields');
  console.log('PASS off-mode-no-op');
} finally {
  await client.close().catch(() => undefined);
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
