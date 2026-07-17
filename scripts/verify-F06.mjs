import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const fixtureHtml = await fs.readFile(path.join(here, 'fixtures', 'f06-unmapped-page.html'), 'utf8');
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'apimemcp-verify-f06-'));

const fixture = http.createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(fixtureHtml);
});

await new Promise((resolve, reject) => {
  fixture.once('error', reject);
  fixture.listen(0, '127.0.0.1', resolve);
});

const address = fixture.address();
if (!address || typeof address === 'string') throw new Error('Fixture server did not expose a TCP port');

const targetUrl = `http://127.0.0.1:${address.port}/`;
const templateId = 'f06-fixture-crystallized';
const expected = {
  name: 'Radical Widget ABC-123',
  price: '$42.00',
  stock: 'In stock',
  detailsUrl: `${targetUrl}catalog/ABC-123`,
};

const client = new Client({ name: 'verify-f06', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(repoRoot, 'dist', 'index.js')],
  cwd: tempDir,
  stderr: 'inherit',
});

function payload(result) {
  return JSON.parse(result.content[0].text);
}

function assertData(label, actual) {
  const comparable = {
    name: actual?.name,
    price: actual?.price,
    stock: actual?.stock,
    detailsUrl: actual?.detailsUrl,
  };
  if (JSON.stringify(comparable) !== JSON.stringify(expected)) {
    throw new Error(`${label} mismatch: ${JSON.stringify(comparable)} !== ${JSON.stringify(expected)}`);
  }
}

try {
  await client.connect(transport);

  const crystallized = payload(await client.callTool({
    name: 'synthesize_schema',
    arguments: {
      targetUrl,
      templateId,
      recording: {
        targetUrl,
        steps: [
          { kind: 'goto', url: targetUrl },
          { kind: 'fill', selector: '#part', value: 'ABC-123', label: 'Part number' },
          { kind: 'click', selector: '#search', label: 'Search' },
          { kind: 'waitFor', selector: '[data-result="ready"]' },
          { kind: 'extract', selector: '[data-name]', field: 'name' },
          { kind: 'extract', selector: '[data-price]', field: 'price' },
          { kind: 'extract', selector: '[data-stock]', field: 'stock' },
          { kind: 'extract', selector: '[data-details]', field: 'detailsUrl', attr: 'href' },
        ],
        outputSchema: {
          type: 'object',
          required: ['name', 'price', 'stock', 'detailsUrl'],
          properties: {
            name: { type: 'string' },
            price: { type: 'string' },
            stock: { type: 'string' },
            detailsUrl: { type: 'string' },
          },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['name', 'price', 'stock', 'detailsUrl'],
        properties: {
          name: { type: 'string' },
          price: { type: 'string' },
          stock: { type: 'string' },
          detailsUrl: { type: 'string' },
        },
      },
    },
  }));

  if (!crystallized.success || crystallized.templateId !== templateId || !crystallized.recordingId) {
    throw new Error(`crystallization failed: ${JSON.stringify(crystallized)}`);
  }
  assertData('crystallized dry-run', crystallized.data);

  const recordingFile = path.join(tempDir, 'templates', 'recordings', `${crystallized.recordingId}.json`);
  await fs.access(recordingFile);

  const secondRun = payload(await client.callTool({ name: 'execute_native_extraction', arguments: { templateId, targetUrl } }));
  if (!secondRun.success) throw new Error(`second execute_native_extraction failed: ${JSON.stringify(secondRun)}`);
  assertData('registered run', secondRun.data);
  if (secondRun.meta.durationMs >= 1000) throw new Error(`registered run was too slow: ${secondRun.meta.durationMs}ms`);

  console.log(`PASS F06 crystallized ${templateId}: ${JSON.stringify(secondRun.data)}`);
} finally {
  await client.close().catch(() => undefined);
  await new Promise((resolve) => fixture.close(resolve));
  await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
