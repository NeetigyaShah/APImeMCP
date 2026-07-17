import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { hashContent, verifyReceipt } from '../dist/provenance.js';

const HTML = '<!doctype html><html><head><title>Provenance Fixture</title></head><body></body></html>';

async function main() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'apimemcp-verify-f11-'));
  const httpServer = http.createServer((_request, response) => response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(HTML));
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const address = httpServer.address();
  if (!address || typeof address === 'string') throw new Error('Fixture server did not expose a TCP port');
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))], cwd: tempDir, stderr: 'inherit' });
  const client = new Client({ name: 'verify-f11', version: '1.0.0' });
  const targetUrl = `http://127.0.0.1:${address.port}/`;
  try {
    await client.connect(transport);
    await client.callTool({ name: 'register_extraction_template', arguments: { templateId: 'provenance-fixture', domainPattern: '127.0.0.1', executableScript: '(() => ({ title: document.title }))()', outputSchema: { type: 'object', required: ['title'], properties: { title: { type: 'string' } } } } });
    const run = await client.callTool({ name: 'execute_native_extraction', arguments: { templateId: 'provenance-fixture', targetUrl } });
    const result = JSON.parse(run.content[0].text);
    const publicKeyResult = await client.callTool({ name: 'get_provenance_public_key', arguments: {} });
    const publicKey = JSON.parse(publicKeyResult.content[0].text);
    if (result.provenance.contentHash !== hashContent(result.data)) throw new Error('Receipt content hash does not match result data');
    if (result.provenance.keyId !== publicKey.keyId) throw new Error('Receipt keyId does not match public key');
    if (!verifyReceipt(result.provenance, publicKey.publicKey).valid) throw new Error('Offline receipt verification failed');
    const tampered = { ...result.provenance, contentHash: `0${result.provenance.contentHash.slice(1)}` };
    if (verifyReceipt(tampered, publicKey.publicKey).valid) throw new Error('Tampered receipt verified unexpectedly');
    console.log(JSON.stringify(result.provenance, null, 2));
    console.log('PASS: offline signature check');
  } finally {
    await client.close();
    await new Promise((resolve) => httpServer.close(resolve));
    await rm(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
