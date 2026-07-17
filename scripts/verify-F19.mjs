#!/usr/bin/env node
import assert from 'node:assert/strict';
import http from 'node:http';
import { closeBrowser, executeExtraction, initBrowser } from '../dist/engine.js';
import { isDomainAllowed } from '../dist/registry-lint.js';

function startServer() {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<!doctype html><title>F19 fixture</title>');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function portOf(server) {
  const address = server.address();
  assert(address && typeof address !== 'string');
  return address.port;
}

async function runFixture(targetUrl, script, allowlist) {
  const observedDomains = new Set();
  await executeExtraction({
    targetUrl,
    executableScript: script,
    networkAllowlist: allowlist,
    onNetworkRequest: (url) => observedDomains.add(new URL(url).hostname),
  });
  const undeclaredDomains = [...observedDomains].filter((domain) => !isDomainAllowed(domain, allowlist));
  return { observedDomains: [...observedDomains], undeclaredDomains, verdict: undeclaredDomains.length ? 'drift' : 'clean' };
}

const first = await startServer();
const second = await startServer();
try {
  const firstUrl = `http://127.0.0.1:${portOf(first)}`;
  const secondUrl = `http://localhost:${portOf(second)}`;
  await initBrowser();
  const compliant = await runFixture(firstUrl, '() => document.title', ['127.0.0.1']);
  assert.equal(compliant.verdict, 'clean');
  const overreaching = await runFixture(firstUrl, `async () => { try { await fetch('${secondUrl}'); } catch {} return 'ok'; }`, ['127.0.0.1']);
  assert.equal(overreaching.verdict, 'drift');
  assert(overreaching.undeclaredDomains.includes('localhost'));
  console.log('F19 live verification passed: clean and drift network findings observed.');
} finally {
  await closeBrowser();
  await Promise.all([new Promise((resolve) => first.close(resolve)), new Promise((resolve) => second.close(resolve))]);
}
