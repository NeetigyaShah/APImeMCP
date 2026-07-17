import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const fixtureDir = fileURLToPath(new URL('./fixtures/f02-drift/', import.meta.url));
const tempDir = await mkdtemp(path.join(os.tmpdir(), 'apimemcp-f02-'));
const fixtureServer = http.createServer(async (request, response) => {
  const filename = request.url === '/v2' ? 'page-v2.html' : 'page-v1.html';
  response.setHeader('Content-Type', 'text/html');
  response.end(await readFile(path.join(fixtureDir, filename)));
});
await new Promise((resolve) => fixtureServer.listen(0, '127.0.0.1', resolve));
const fixturePort = fixtureServer.address().port;
const client = new Client({ name: 'f02-verify-client', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))],
  cwd: tempDir,
  stderr: 'inherit',
});

try {
  await client.connect(transport);
  const toolsBefore = (await client.listTools()).tools.map((tool) => tool.name).sort();
  await client.callTool({
    name: 'register_extraction_template',
    arguments: {
      templateId: 'f02-drift',
      domainPattern: '127.0.0.1',
      executableScript: "(() => ({ name: document.querySelector('#name, #product-name')?.textContent ?? null, price: Number(document.querySelector('#price')?.textContent) || null }))()",
      outputSchema: { type: 'object', properties: { name: { type: 'string' }, price: { type: 'number' } }, required: ['name', 'price'] },
    },
  });
  const matching = await client.callTool({ name: 'execute_native_extraction', arguments: { templateId: 'f02-drift', targetUrl: `http://127.0.0.1:${fixturePort}/v1` } });
  const drifted = await client.callTool({ name: 'execute_native_extraction', arguments: { templateId: 'f02-drift', targetUrl: `http://127.0.0.1:${fixturePort}/v2` } });
  const stats = JSON.parse((await client.callTool({ name: 'get_extraction_stats', arguments: {} })).content[0].text);
  const row = stats.templates.find((item) => item.templateId === 'f02-drift');
  const dashboard = await fetch('http://127.0.0.1:3000/').then((response) => response.text());
  const matchingResult = JSON.parse(matching.content[0].text);
  const driftedResult = JSON.parse(drifted.content[0].text);
  const ok = matchingResult.success === true && driftedResult.success === true && row?.driftCount === 1 && typeof row.lastDriftAt === 'string' && dashboard.includes('sla.driftCount') && !toolsBefore.includes('check_drift');
  console.log(ok ? 'PASS' : 'FAIL', JSON.stringify({ matching: matchingResult, drifted: driftedResult, stats: row, noNewTool: !toolsBefore.includes('check_drift') }));
  process.exitCode = ok ? 0 : 1;
} finally {
  await client.close();
  await new Promise((resolve) => fixtureServer.close(resolve));
  await rm(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
