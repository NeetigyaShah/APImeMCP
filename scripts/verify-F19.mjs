#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFile = promisify(execFileCallback);
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const fixtureDir = path.join(here, 'fixtures', 'f19');
const fixtureIds = ['compliant-template', 'overreaching-template'];

async function readFixtureEntry(templateId) {
  return JSON.parse(await readFile(path.join(fixtureDir, `${templateId}.json`), 'utf8'));
}

async function runNode(args, options = {}) {
  try {
    return await execFile(process.execPath, args, { timeout: 20_000, ...options });
  } catch (error) {
    return { stdout: error.stdout ?? '', stderr: error.stderr ?? '', code: error.code };
  }
}

function startServer(handler) {
  const server = createServer(handler);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function portOf(server) {
  const address = server.address();
  assert(address && typeof address !== 'string');
  return address.port;
}

const secondary = await startServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/plain' }).end('secondary fixture');
});
const secondaryOrigin = `http://localhost:${portOf(secondary)}`;
const fixtureEntries = Object.fromEntries((await Promise.all(fixtureIds.map(readFixtureEntry))).map((entry) => [entry.templateId, entry]));
const primary = await startServer(async (request, response) => {
  const requestPath = request.url ?? '/';
  if (requestPath === '/registry/manifest.json') {
    const manifest = Object.fromEntries(Object.entries(fixtureEntries).map(([templateId, entry]) => [templateId, {
      ...entry,
      fixedTargetUrl: entry.fixedTargetUrl.replace('{{PRIMARY_ORIGIN}}', primaryOrigin),
    }]));
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(manifest));
    return;
  }
  const scriptMatch = requestPath.match(/^\/registry\/(.+)\.js$/);
  if (scriptMatch && fixtureEntries[scriptMatch[1]]) {
    const source = (await readFile(path.join(fixtureDir, `${scriptMatch[1]}.js`), 'utf8')).replace('{{SECONDARY_ORIGIN}}', secondaryOrigin);
    response.writeHead(200, { 'content-type': 'application/javascript' }).end(source);
    return;
  }
  response.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>F19 fixture</title>');
});
const primaryOrigin = `http://127.0.0.1:${portOf(primary)}`;
const tempDir = await mkdtemp(path.join(os.tmpdir(), 'apimemcp-f19-'));

try {
  const registryEnv = { ...process.env, APIMEMCP_REGISTRY_BASE: `${primaryOrigin}/registry` };
  const compliantEntry = fixtureEntries['compliant-template'];
  const missingAllowlistEntry = await readFixtureEntry('missing-allowlist-template');
  const compliantLintDir = path.join(tempDir, 'lint-compliant');
  const failingLintDir = path.join(tempDir, 'lint-missing-allowlist');
  await Promise.all([mkdir(compliantLintDir, { recursive: true }), mkdir(failingLintDir, { recursive: true })]);
  await Promise.all([
    writeFile(path.join(compliantLintDir, 'manifest.json'), JSON.stringify({ [compliantEntry.templateId]: compliantEntry })),
    writeFile(path.join(compliantLintDir, 'compliant-template.js'), await readFile(path.join(fixtureDir, 'compliant-template.js'))),
    writeFile(path.join(failingLintDir, 'manifest.json'), JSON.stringify({ [missingAllowlistEntry.templateId]: missingAllowlistEntry })),
    writeFile(path.join(failingLintDir, 'missing-allowlist-template.js'), await readFile(path.join(fixtureDir, 'missing-allowlist-template.js'))),
  ]);

  const cleanLint = await runNode([path.join(repoRoot, 'scripts', 'lint-templates.mjs'), compliantLintDir]);
  assert.equal(cleanLint.code, undefined, cleanLint.stderr);
  const failingLint = await runNode([path.join(repoRoot, 'scripts', 'lint-templates.mjs'), failingLintDir]);
  assert.equal(failingLint.code, 1);
  assert.match(failingLint.stderr, /missing\/empty network allowlist/);

  const cliDir = path.join(tempDir, 'cli');
  await mkdir(cliDir, { recursive: true });
  const cli = await runNode([path.join(repoRoot, 'dist', 'index.js'), 'add', 'fixture.example'], { cwd: cliDir, env: registryEnv });
  assert.equal(cli.code, undefined, cli.stderr);
  assert.equal(await readFile(path.join(cliDir, 'templates', 'compliant-template.js'), 'utf8'), await readFile(path.join(fixtureDir, 'compliant-template.js'), 'utf8'));
  const registeredManifest = JSON.parse(await readFile(path.join(cliDir, 'templates', 'manifest.json'), 'utf8'));
  assert.equal(registeredManifest['compliant-template'].templateId, 'compliant-template');

  const badgesDir = path.join(tempDir, 'badges');
  const verification = await runNode([path.join(repoRoot, 'scripts', 'verify-registry.mjs'), '--out', badgesDir], { env: registryEnv });
  assert.equal(verification.code, undefined, verification.stderr);
  assert.match(verification.stdout, /compliant-template: passing \(clean\)/);
  assert.match(verification.stdout, /overreaching-template: failing \(drift: undeclared localhost\)/);
  console.log('F19 live verification passed: lint, CLI, and registry network drift checks succeeded.');
} finally {
  await Promise.all([new Promise((resolve) => primary.close(resolve)), new Promise((resolve) => secondary.close(resolve))]);
  await rm(tempDir, { recursive: true, force: true });
}
