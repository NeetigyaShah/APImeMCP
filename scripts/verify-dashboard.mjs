import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const HTML = '<!doctype html><html><head><title>Dashboard Test</title></head><body><h1 id="target">1</h1></body></html>';
const EXTRACTION_SCRIPT = "(() => ({ value: document.getElementById('target').textContent }))()";

const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'mcp-compiler-dashboard-'));

const fixtureServer = http.createServer((_req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end(HTML);
});
await new Promise((resolve) => fixtureServer.listen(0, '127.0.0.1', resolve));
const fixturePort = fixtureServer.address().port;

const serverEntry = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry],
  cwd: tmpDir,
  stderr: 'inherit',
});
const client = new Client({ name: 'dashboard-test-client', version: '1.0.0' });

try {
  await client.connect(transport);

  await client.callTool({
    name: 'register_extraction_template',
    arguments: { templateId: 'dashboard-smoke', domainPattern: '127.0.0.1', executableScript: EXTRACTION_SCRIPT },
  });

  // give the dashboard a moment to bind after server startup
  await new Promise((resolve) => setTimeout(resolve, 500));

  const rootRes = await fetch('http://127.0.0.1:3000/');
  const rootHtml = await rootRes.text();
  const hasCard = rootHtml.includes('dashboard-smoke');
  console.log('GET / status:', rootRes.status, '| shows registered template card:', hasCard);

  const runRes = await fetch('http://127.0.0.1:3000/api/run/dashboard-smoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: `http://127.0.0.1:${fixturePort}/` }),
  });
  const runJson = await runRes.json();
  console.log('POST /api/run/... ->', JSON.stringify(runJson));

  const badRes = await fetch('http://127.0.0.1:3000/api/run/dashboard-smoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'ftp://example.com' }),
  });
  console.log('POST /api/run/... with bad scheme -> status:', badRes.status);

  const ok =
    rootRes.status === 200 &&
    hasCard &&
    runJson.success === true &&
    runJson.data?.value === '1' &&
    badRes.status === 400;
  console.log(ok ? 'PASS' : 'FAIL');
  process.exitCode = ok ? 0 : 1;
} finally {
  await client.close();
  fixtureServer.close();
  await rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
