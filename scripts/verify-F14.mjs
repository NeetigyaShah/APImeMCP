import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const fixtureHtml = '<!doctype html><html><body><h1 id="target">metric fixture</h1></body></html>';
const extractionScript = "(() => ({ value: document.getElementById('target').textContent }))()";
const tempDir = await mkdtemp(path.join(os.tmpdir(), 'apimemcp-f14-'));
const fixtureServer = http.createServer((_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end(fixtureHtml);
});
await new Promise((resolve) => fixtureServer.listen(0, '127.0.0.1', resolve));
const fixturePort = fixtureServer.address().port;

const serverEntry = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const transport = new StdioClientTransport({ command: process.execPath, args: [serverEntry], cwd: tempDir, stderr: 'inherit' });
const client = new Client({ name: 'f14-verify-client', version: '1.0.0' });

try {
  await client.connect(transport);
  await client.callTool({
    name: 'register_extraction_template',
    arguments: { templateId: 'f14-metrics', domainPattern: '127.0.0.1', executableScript: extractionScript },
  });

  const successfulRun = await client.callTool({
    name: 'execute_native_extraction',
    arguments: { templateId: 'f14-metrics', targetUrl: `http://127.0.0.1:${fixturePort}/` },
  });
  const failedRun = await client.callTool({
    name: 'execute_native_extraction',
    arguments: { templateId: 'f14-metrics', targetUrl: 'http://127.0.0.1:1/' },
  });
  const unknownTemplateRun = await client.callTool({
    name: 'execute_native_extraction',
    arguments: { templateId: 'missing-f14-template' },
  });
  const statsResult = await client.callTool({ name: 'get_extraction_stats', arguments: {} });
  const metrics = (await readFile(path.join(tempDir, 'templates', 'extraction_metrics.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const stats = JSON.parse(statsResult.content[0].text);
  const sla = stats.templates.find((item) => item.templateId === 'f14-metrics');
  const success = JSON.parse(successfulRun.content[0].text);
  const failure = JSON.parse(failedRun.content[0].text);
  const unknownTemplateFailure = JSON.parse(unknownTemplateRun.content[0].text);
  const ok =
    success.success === true &&
    failure.success === false &&
    unknownTemplateFailure.success === false &&
    metrics.length === 3 &&
    metrics.some((item) => item.success === true && item.durationMs > 0) &&
    metrics.some((item) => item.success === false && item.durationMs > 0 && item.error) &&
    metrics.some(
      (item) =>
        item.templateId === 'missing-f14-template' &&
        item.kind === 'extraction' &&
        item.success === false &&
        item.error === 'No registered template with templateId "missing-f14-template"'
    ) &&
    sla?.runs === 2 &&
    sla.successCount === 1 &&
    sla.successRate === 0.5 &&
    sla.p95DurationMs > 0 &&
    typeof sla.lastRunAt === 'string' &&
    typeof sla.lastError === 'string';

  console.log(ok ? 'PASS' : 'FAIL', JSON.stringify({ metrics, sla }));
  process.exitCode = ok ? 0 : 1;
} finally {
  await client.close();
  await new Promise((resolve) => fixtureServer.close(resolve));
  await rm(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
