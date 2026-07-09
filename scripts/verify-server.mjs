import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const HTML = '<!doctype html><html><head><title>Server Smoke Test</title></head><body><h1 id="target">7</h1></body></html>';
const EXTRACTION_SCRIPT = "(() => ({ title: document.title, value: document.getElementById('target').textContent }))()";

async function main() {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'apimemcp-smoke-'));

  const httpServer = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(HTML);
  });
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = httpServer.address();

  const serverEntry = fileURLToPath(new URL('../dist/index.js', import.meta.url));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    cwd: tmpDir,
    stderr: 'inherit',
  });
  const client = new Client({ name: 'smoke-test-client', version: '1.0.0' });

  try {
    await client.connect(transport);

    const tools = await client.listTools();
    const toolNames = tools.tools.map((t) => t.name).sort();
    console.log('Tools:', toolNames);
    if (JSON.stringify(toolNames) !== JSON.stringify(['execute_native_extraction', 'register_extraction_template'])) {
      throw new Error('Unexpected tool list');
    }

    const registerResult = await client.callTool({
      name: 'register_extraction_template',
      arguments: {
        templateId: 'smoke-test',
        domainPattern: '127.0.0.1',
        executableScript: EXTRACTION_SCRIPT,
      },
    });
    console.log('Register result:', registerResult.content[0].text);

    const extractResult = await client.callTool({
      name: 'execute_native_extraction',
      arguments: { targetUrl: `http://127.0.0.1:${port}/` },
    });
    const payload = JSON.parse(extractResult.content[0].text);
    console.log('Extraction result:', payload);
    const ok = payload.success === true && payload.data.title === 'Server Smoke Test' && payload.data.value === '7';
    console.log(ok ? 'PASS' : 'FAIL');
    process.exitCode = ok ? 0 : 1;
  } finally {
    await client.close();
    httpServer.close();
    await rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
