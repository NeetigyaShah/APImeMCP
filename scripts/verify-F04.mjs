#!/usr/bin/env node
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const fixtureDir = fileURLToPath(new URL('./fixtures/self-heal/', import.meta.url));
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'apimemcp-f04-'));
const registryRemote = path.join(tempDir, 'registry.git');
const registrySeed = path.join(tempDir, 'registry-seed');
const serverCwd = path.join(tempDir, 'server');
await fs.mkdir(serverCwd, { recursive: true });

let version = 'v1';
const fixtureServer = createServer(async (_request, response) => {
  const html = await fs.readFile(path.join(fixtureDir, `${version}.html`));
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html);
});

function runGit(args, cwd = registrySeed) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function parseTool(result) {
  return JSON.parse(result.content[0].text);
}

async function runNode(args, options) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { ...options, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${process.execPath} ${args.join(' ')} exited with ${code}`));
    });
  });
}

async function existsAndNonEmpty(filePath) {
  const info = await fs.stat(filePath);
  return info.isFile() && info.size > 0;
}

async function seedRegistry(targetUrl, oldScript) {
  execFileSync('git', ['init', '--bare', registryRemote], { encoding: 'utf8' });
  execFileSync('git', ['clone', registryRemote, registrySeed], { encoding: 'utf8' });
  runGit(['config', 'user.name', 'Test Bot']);
  runGit(['config', 'user.email', 'bot@example.com']);
  await fs.mkdir(path.join(registrySeed, 'registry'), { recursive: true });
  await fs.writeFile(path.join(registrySeed, 'registry', 'fixture.js'), oldScript, 'utf8');
  await fs.writeFile(
    path.join(registrySeed, 'registry', 'manifest.json'),
    JSON.stringify({
      fixture: {
        templateId: 'fixture',
        domainPattern: '127.0.0.1',
        scriptPath: 'registry/fixture.js',
        fixedTargetUrl: targetUrl,
        outputSchema: { type: 'object', required: ['title'], properties: { title: { type: 'string' } } },
        createdAt: '2026-07-17T00:00:00.000Z',
        updatedAt: '2026-07-17T00:00:00.000Z',
      },
    }, null, 2),
    'utf8',
  );
  runGit(['add', 'registry']);
  runGit(['commit', '-m', 'seed fixture registry']);
  runGit(['branch', '-M', 'main']);
  runGit(['push', 'origin', 'main']);
}

await new Promise((resolve, reject) => {
  fixtureServer.once('error', reject);
  fixtureServer.listen(0, '127.0.0.1', resolve);
});

const address = fixtureServer.address();
if (!address || typeof address === 'string') throw new Error('Fixture server did not expose a TCP port');
const targetUrl = `http://127.0.0.1:${address.port}/`;
const oldScript = '() => ({ title: document.querySelector("#title")?.textContent ?? null })';
const fixedScript = '() => ({ title: document.querySelector("#product-title")?.textContent ?? "" })';
await seedRegistry(targetUrl, oldScript);

const client = new Client({ name: 'f04-verify-client', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))],
  cwd: serverCwd,
  stderr: 'inherit',
  env: {
    ...process.env,
    APIMEMCP_REGISTRY_REPO_PATH: registryRemote,
    APIMEMCP_REGISTRY_DEFAULT_BRANCH: 'main',
  },
});

try {
  await client.connect(transport);
  const tools = (await client.listTools()).tools.map((tool) => tool.name);
  for (const name of ['request_template_heal', 'submit_template_heal', 'list_pending_heals']) {
    if (!tools.includes(name)) throw new Error(`Missing F04 tool: ${name}`);
  }

  await client.callTool({
    name: 'register_extraction_template',
    arguments: {
      templateId: 'fixture',
      domainPattern: '127.0.0.1',
      executableScript: oldScript,
      fixedTargetUrl: targetUrl,
      outputSchema: { type: 'object', required: ['title'], properties: { title: { type: 'string' } } },
    },
  });
  const v1 = parseTool(await client.callTool({ name: 'execute_native_extraction', arguments: { templateId: 'fixture' } }));
  if (!v1.success || v1.schemaValidation?.valid !== true) throw new Error(`v1 did not pass: ${JSON.stringify(v1)}`);

  version = 'v2';
  const drifted = parseTool(await client.callTool({ name: 'execute_native_extraction', arguments: { templateId: 'fixture', snapshot: 'check' } }));
  if (!drifted.success || drifted.schemaValidation?.valid !== false || !drifted.drift?.hasDrift) {
    throw new Error(`v2 did not show schema/drift failure: ${JSON.stringify(drifted)}`);
  }

  const requested = parseTool(await client.callTool({ name: 'request_template_heal', arguments: { templateId: 'fixture' } }));
  const ticketId = requested.ticketId;
  const domPath = path.resolve(serverCwd, requested.forensics.domSnapshotPath);
  const screenshotPath = path.resolve(serverCwd, requested.forensics.screenshotPath);
  if (!(await existsAndNonEmpty(domPath)) || !(await existsAndNonEmpty(screenshotPath))) {
    throw new Error(`Forensics were not written: ${JSON.stringify(requested.forensics)}`);
  }
  if (!requested.forensics.oldScript.includes('#title') || !requested.forensics.driftDiff?.hasDrift) {
    throw new Error(`Forensics missing old script or drift diff: ${JSON.stringify(requested.forensics)}`);
  }

  const invalid = parseTool(await client.callTool({ name: 'submit_template_heal', arguments: { templateId: 'fixture', ticketId, newScript: oldScript } }));
  if (invalid.valid !== false || !invalid.rejectedReason) throw new Error(`Invalid submission was not rejected: ${JSON.stringify(invalid)}`);
  const pending = parseTool(await client.callTool({ name: 'list_pending_heals', arguments: {} }));
  if (!pending.some((ticket) => ticket.id === ticketId && ticket.status === 'pending')) {
    throw new Error(`Rejected ticket did not remain pending: ${JSON.stringify(pending)}`);
  }

  const healed = parseTool(await client.callTool({ name: 'submit_template_heal', arguments: { templateId: 'fixture', ticketId, newScript: fixedScript } }));
  if (healed.valid !== true || !healed.branch || !healed.prUrl) throw new Error(`Corrected submission did not open a branch: ${JSON.stringify(healed)}`);
  const branchScript = execFileSync('git', ['--git-dir', registryRemote, 'show', `${healed.branch}:registry/fixture.js`], { encoding: 'utf8' });
  const mainScript = execFileSync('git', ['--git-dir', registryRemote, 'show', 'main:registry/fixture.js'], { encoding: 'utf8' });
  if (!branchScript.includes('#product-title') || !mainScript.includes('#title')) {
    throw new Error('Registry branch/main contents did not match self-heal expectations');
  }
  const afterOpen = parseTool(await client.callTool({ name: 'list_pending_heals', arguments: {} }));
  if (!afterOpen.some((ticket) => ticket.id === ticketId && ticket.status === 'pr-opened')) {
    throw new Error(`Opened ticket was not visible as pr-opened: ${JSON.stringify(afterOpen)}`);
  }

  const sweepCwd = path.join(tempDir, 'sweep');
  const badgesDir = path.join(sweepCwd, '.verify-badges');
  await fs.mkdir(badgesDir, { recursive: true });
  await fs.writeFile(path.join(badgesDir, 'fixture.json'), JSON.stringify({ schemaVersion: 1, label: 'apimemcp', message: 'failing', color: 'red' }));
  const refsBefore = execFileSync('git', ['--git-dir', registryRemote, 'for-each-ref', '--format=%(refname)', 'refs/heads'], { encoding: 'utf8' });
  await runNode([
    fileURLToPath(new URL('./self-heal.mjs', import.meta.url)),
    '--badges',
    badgesDir,
    '--manifest',
    path.join(registrySeed, 'registry', 'manifest.json'),
  ], { cwd: sweepCwd, env: { ...process.env } });
  const sweepTickets = await fs.readdir(path.join(sweepCwd, 'templates', 'heal-tickets'));
  const refsAfter = execFileSync('git', ['--git-dir', registryRemote, 'for-each-ref', '--format=%(refname)', 'refs/heads'], { encoding: 'utf8' });
  if (sweepTickets.length !== 1 || refsBefore !== refsAfter) throw new Error('self-heal sweep created unexpected artifacts');

  console.log('PASS', JSON.stringify({
    ticketId,
    domPath,
    screenshotPath,
    branch: healed.branch,
    branchCommit: execFileSync('git', ['--git-dir', registryRemote, 'rev-parse', healed.branch], { encoding: 'utf8' }).trim(),
    mainUnchanged: mainScript.includes('#title'),
  }));
} finally {
  await client.close().catch(() => undefined);
  await new Promise((resolve) => fixtureServer.close(resolve));
  await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
