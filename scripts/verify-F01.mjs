import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const HTML = '<!doctype html><html><head><title>Schema Contract Fixture</title></head><body></body></html>';
const schema = { type: 'object', required: ['title'], properties: { title: { type: 'string' } } };

async function main() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'apimemcp-verify-f01-'));
  const httpServer = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(HTML);
  });
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const address = httpServer.address();
  if (!address || typeof address === 'string') throw new Error('Fixture server did not expose a TCP port');

  const serverEntry = fileURLToPath(new URL('../dist/index.js', import.meta.url));
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverEntry], cwd: tempDir, stderr: 'inherit' });
  const client = new Client({ name: 'verify-f01', version: '1.0.0' });
  const targetUrl = `http://127.0.0.1:${address.port}/`;

  try {
    await client.connect(transport);
    for (const [templateId, executableScript, outputSchema] of [
      ['schema-pass', '(() => ({ title: document.title }))()', schema],
      ['schema-fail', '(() => ({ title: 42 }))()', schema],
      ['schema-absent', '(() => ({ title: document.title }))()', undefined],
    ]) {
      await client.callTool({
        name: 'register_extraction_template',
        arguments: { templateId, domainPattern: '127.0.0.1', executableScript, outputSchema },
      });
    }

    const run = async (templateId) => {
      const result = await client.callTool({ name: 'execute_native_extraction', arguments: { templateId, targetUrl } });
      return JSON.parse(result.content[0].text);
    };
    const passing = await run('schema-pass');
    const failing = await run('schema-fail');
    const absent = await run('schema-absent');

    if (passing.schemaValidation?.valid !== true) throw new Error('Expected matching schema to validate');
    if (failing.schemaValidation?.valid !== false || !failing.schemaValidation.errors?.length) {
      throw new Error('Expected mismatching schema to return validation errors');
    }
    if ('schemaValidation' in absent) throw new Error('Expected schemaValidation to be absent without outputSchema');

    console.log('Schema pass:', passing.schemaValidation);
    console.log('Schema fail:', failing.schemaValidation);
    console.log('Schema absent: no schemaValidation');
  } finally {
    await client.close();
    await new Promise((resolve) => httpServer.close(resolve));
    await rm(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
