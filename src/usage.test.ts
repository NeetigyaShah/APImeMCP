import { once } from 'node:events';
import { createServer } from 'node:http';
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { buildStandaloneScript, getScriptPath } from './usage.js';
import type { ManifestEntry } from './types.js';

const templateId = 'usage-standalone-regression';
const scriptPath = getScriptPath(templateId);
const entry: ManifestEntry = {
  templateId,
  domainPattern: '127.0.0.1',
  scriptPath: 'templates/usage-standalone-regression.js',
  createdAt: '2026-07-17T00:00:00.000Z',
  updatedAt: '2026-07-17T00:00:00.000Z',
};

const server = createServer((_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end('<!doctype html><title>Standalone usage fixture</title>');
});

let targetUrl = '';

beforeAll(async () => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture server did not expose a TCP port');
  targetUrl = `http://127.0.0.1:${address.port}/`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(scriptPath, { force: true });
});

test('emitted standalone extraction usage parses and runs async scripts', async () => {
  await writeFile(scriptPath, buildStandaloneScript(entry, 'async () => ({ title: document.title })'));
  const child = spawn(process.execPath, [path.resolve(scriptPath), targetUrl], { cwd: process.cwd() });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk; });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk; });
  const [exitCode] = await once(child, 'exit') as [number | null];

  expect(stderr).toBe('');
  expect(exitCode).toBe(0);
  expect(JSON.parse(stdout)).toEqual({ title: 'Standalone usage fixture' });
}, 30_000);
