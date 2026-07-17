#!/usr/bin/env node
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const serverEntry = path.resolve(projectRoot, 'dist/index.js');
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'apimemcp-f09-'));

const readHtml = await fs.readFile(path.join(__dirname, 'fixtures/f09-read-source.html'));
const writeHtml = await fs.readFile(path.join(__dirname, 'fixtures/f09-write-form.html'));

const fixtureServer = http.createServer((req, res) => {
  if (req.url === '/read') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(readHtml);
  } else if (req.url === '/write') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(writeHtml);
  } else {
    res.writeHead(404).end('Not found');
  }
});
await new Promise((resolve, reject) => {
  fixtureServer.once('error', reject);
  fixtureServer.listen(0, '127.0.0.1', resolve);
});
const addr = fixtureServer.address();
const readUrl = `http://127.0.0.1:${addr.port}/read`;
const writeUrl = `http://127.0.0.1:${addr.port}/write`;

const client = new Client({ name: 'f09-verify-client', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry],
  cwd: tempDir,
  stderr: 'inherit',
});

function callTool(name, args) {
  return client.callTool({ name, arguments: args }, undefined, { timeout: 30_000 });
}

function parseResult(result) {
  const text = result.content?.[0]?.text ?? '';
  if (result.isError) throw new Error(`Tool call failed: ${text}`);
  return JSON.parse(text);
}

try {
  await client.connect(transport);

  console.log('Test 1: Register read template');
  await callTool('register_extraction_template', {
    templateId: 'f09-read',
    domainPattern: '127.0.0.1',
    executableScript: `
      (() => ({
        name: document.getElementById('name').textContent,
        email: document.getElementById('email').textContent,
        extra: document.getElementById('extra').textContent,
      }))()
    `,
    fixedTargetUrl: readUrl,
  });
  console.log('  registered f09-read');

  console.log('Test 2: Register write template');
  await callTool('register_extraction_template', {
    templateId: 'f09-write',
    domainPattern: '127.0.0.1',
    templateKind: 'write',
    fixedTargetUrl: writeUrl,
    executableScript: '(() => {})()',
    writeScript: `
      (input, opts) => {
        document.getElementById('full_name').value = input.full_name || '';
        document.getElementById('email').value = input.email || '';
        if (!opts.dryRun) document.getElementById('contact-form').requestSubmit();
        return { filled: true };
      }
    `,
  });
  console.log('  registered f09-write');

  console.log('Test 3: Register pipeline (read -> transform -> write)');
  await callTool('register_pipeline', {
    pipelineId: 'f09-verify-pipeline',
    name: 'F09 verify pipeline',
    steps: [
      { kind: 'read', id: 'read-step', templateId: 'f09-read' },
      {
        kind: 'write',
        id: 'write-step',
        fromStepId: 'read-step',
        targetTemplateId: 'f09-write',
        transform: {
          version: 1,
          ops: [
            { op: 'rename', from: 'name', to: 'full_name' },
            { op: 'pick', fields: ['full_name', 'email'] },
          ],
        },
      },
    ],
  });
  console.log('  registered f09-verify-pipeline');

  console.log('Test 4: Run pipeline end to end (real browser fill + submit)');
  const runResult = parseResult(await callTool('run_pipeline', { pipelineId: 'f09-verify-pipeline' }));
  if (!runResult.success) {
    throw new Error(`Pipeline run failed: ${JSON.stringify(runResult)}`);
  }
  const writeStepResult = runResult.steps.find((s) => s.stepId === 'write-step');
  if (!writeStepResult || !writeStepResult.success) {
    throw new Error(`Write step did not succeed: ${JSON.stringify(writeStepResult)}`);
  }
  const readStepResult = runResult.steps.find((s) => s.stepId === 'read-step');
  if (readStepResult.output?.extra === undefined) {
    throw new Error(`Read step did not capture the extra field (transform should only drop it downstream, not at read time): ${JSON.stringify(readStepResult)}`);
  }
  const writeInput = writeStepResult.output?.results?.[0]?.input;
  if (writeInput?.extra !== undefined) {
    throw new Error(`Transform did not drop the 'extra' field before the write step: ${JSON.stringify(writeStepResult.output)}`);
  }
  if (writeInput?.full_name !== 'John Doe' || writeInput?.email !== 'john@example.com') {
    throw new Error(`Transform did not correctly rename/pass through fields: ${JSON.stringify(writeStepResult.output)}`);
  }
  if (writeStepResult.output?.results?.[0]?.success !== true || writeStepResult.output?.results?.[0]?.dryRun !== false) {
    throw new Error(`Write did not report a genuine non-dry-run success: ${JSON.stringify(writeStepResult.output)}`);
  }

  console.log(`  read step output: ${JSON.stringify(readStepResult.output)}`);
  console.log(`  write step output: ${JSON.stringify(writeStepResult.output)}`);
  console.log('\nPASS F09 bidirectional flows: read -> transform -> write verified live with a real browser form fill + submit');
  process.exitCode = 0;
} catch (error) {
  console.log(`FAIL ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await client.close().catch(() => undefined);
  await new Promise((resolve) => fixtureServer.close(resolve));
  await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => undefined);
}
