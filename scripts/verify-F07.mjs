import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const tempDir = await mkdtemp(path.join(os.tmpdir(), 'apimemcp-f07-'));
const fixtureServer = http.createServer((_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end('<!doctype html><html><body><h1 id="target">pipeline fixture</h1></body></html>');
});
await new Promise((resolve) => fixtureServer.listen(0, '127.0.0.1', resolve));
const fixturePort = fixtureServer.address().port;
const targetUrl = `http://127.0.0.1:${fixturePort}/`;
const serverEntry = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const transport = new StdioClientTransport({ command: process.execPath, args: [serverEntry], cwd: tempDir, stderr: 'inherit' });
const client = new Client({ name: 'f07-verify-client', version: '1.0.0' });

try {
  await client.connect(transport);
  await client.callTool({ name: 'register_extraction_template', arguments: {
    templateId: 'f07-list', domainPattern: '127.0.0.1', executableScript: '({ items: [{ url: location.origin + "/detail" }] })',
  } });
  await client.callTool({ name: 'register_extraction_template', arguments: {
    templateId: 'f07-detail', domainPattern: '127.0.0.1', executableScript: '({ received: location.href })',
  } });
  await client.callTool({ name: 'register_pipeline', arguments: {
    pipelineId: 'f07-fixture', name: 'F07 fixture', steps: [
      { id: 'list', templateId: 'f07-list', inputMapping: { targetUrl: '$init.targetUrl' } },
      { id: 'detail', templateId: 'f07-detail', inputMapping: { targetUrl: 'list.items.0.url' } },
    ],
  } });
  const run = await client.callTool({ name: 'run_pipeline', arguments: { pipelineId: 'f07-fixture', initialInput: { targetUrl } } });
  const result = JSON.parse(run.content[0].text);
  const expectedUrl = `${targetUrl}detail`;
  const ok = result.success === true && result.steps.length === 2 && result.steps[1].output?.received === expectedUrl;
  console.log(`${ok ? 'PASS' : 'FAIL'} step1=${result.steps[0]?.success} step2=${result.steps[1]?.success} received=${result.steps[1]?.output?.received}`);
  process.exitCode = ok ? 0 : 1;
} finally {
  await client.close();
  await new Promise((resolve) => fixtureServer.close(resolve));
  await rm(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
