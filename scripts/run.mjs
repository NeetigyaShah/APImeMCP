#!/usr/bin/env node
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';

const [, , templateId, targetUrl] = process.argv;

if (!templateId || !targetUrl) {
  console.error('Usage: node scripts/run.mjs <templateId> <targetUrl>');
  process.exit(1);
}

const serverEntry = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const transport = new StdioClientTransport({ command: process.execPath, args: [serverEntry], stderr: 'inherit' });
const client = new Client({ name: 'run-cli', version: '1.0.0' });

try {
  await client.connect(transport);
  const result = await client.callTool(
    { name: 'execute_native_extraction', arguments: { targetUrl, templateId } },
    undefined,
    // ponytail: paginated live extractions can run many minutes; default 60s client
    // request timeout is too short. Bump per-call rather than adding config plumbing.
    { timeout: 30 * 60 * 1000 }
  );
  const payload = JSON.parse(result.content[0].text);
  console.log(JSON.stringify(payload, null, 2));
  process.exitCode = payload.success ? 0 : 1;
} finally {
  await client.close();
}
