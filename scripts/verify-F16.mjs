import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { performance } from 'node:perf_hooks';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.APIMEMCP_CACHE_TTL_MS ??= '1000';

const fixtureHtml = '<!doctype html><html><body><h1 id="target">cache fixture</h1></body></html>';
const extractionScript = "(() => ({ value: document.getElementById('target').textContent }))()";
const fixtureServer = http.createServer((_request, response) => {
  if (_request.url === '/failure') {
    _request.socket.destroy();
    return;
  }
  response.setHeader('Content-Type', 'text/html');
  response.end(fixtureHtml);
});
await new Promise((resolve) => fixtureServer.listen(0, '127.0.0.1', resolve));
const fixturePort = fixtureServer.address().port;
const targetUrl = `http://127.0.0.1:${fixturePort}/`;
const proxyServer = http.createServer((request, response) => {
  const target = new URL(request.url);
  const upstream = http.request(target, {
    method: request.method,
    headers: request.headers,
  }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });
  upstream.on('error', () => response.destroy());
  request.pipe(upstream);
});
await new Promise((resolve) => proxyServer.listen(0, '127.0.0.1', resolve));
const proxyPort = proxyServer.address().port;
const proxyUrl = `http://127.0.0.1:${proxyPort}`;
const serverEntry = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const tempDir = await mkdtemp(path.join(os.tmpdir(), 'apimemcp-f16-'));
const transport = new StdioClientTransport({ command: process.execPath, args: [serverEntry], cwd: tempDir, stderr: 'inherit' });
const client = new Client({ name: 'f16-verify-client', version: '1.0.0' });

const call = async (arguments_) => {
  const started = performance.now();
  const response = await client.callTool({ name: 'execute_native_extraction', arguments: arguments_ });
  return { response: JSON.parse(response.content[0].text), durationMs: performance.now() - started };
};

try {
  await client.connect(transport);
  await client.callTool({ name: 'register_extraction_template', arguments: {
    templateId: 'f16-cache', domainPattern: '127.0.0.1', executableScript: extractionScript,
  } });

  const miss = await call({ templateId: 'f16-cache', targetUrl });
  const hit = await call({ templateId: 'f16-cache', targetUrl });
  const cookieA = await call({ templateId: 'f16-cache', targetUrl, cookieString: 'session=a' });
  const cookieB = await call({ templateId: 'f16-cache', targetUrl, cookieString: 'session=b' });
  const proxy = await call({ templateId: 'f16-cache', targetUrl, proxyUrl });
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const expired = await call({ templateId: 'f16-cache', targetUrl });
  const failureUrl = `http://127.0.0.1:${fixturePort}/failure`;
  const failureA = await call({ templateId: 'f16-cache', targetUrl: failureUrl });
  const failureB = await call({ templateId: 'f16-cache', targetUrl: failureUrl });

  const pass = miss.response.success === true &&
    hit.response.success === true &&
    JSON.stringify(miss.response) === JSON.stringify(hit.response) &&
    hit.durationMs * 10 < miss.durationMs &&
    cookieA.response.success === true && cookieB.response.success === true &&
    proxy.response.success === true && expired.response.success === true &&
    failureA.response.success === false && failureB.response.success === false;
  console.log(pass ? 'PASS' : 'FAIL', JSON.stringify({
    missMs: miss.durationMs, hitMs: hit.durationMs, cookieAMs: cookieA.durationMs,
    cookieBMs: cookieB.durationMs, proxyMs: proxy.durationMs, expiredMs: expired.durationMs,
    failureAMs: failureA.durationMs, failureBMs: failureB.durationMs,
  }));
  process.exitCode = pass ? 0 : 1;
} finally {
  await client.close();
  await new Promise((resolve) => proxyServer.close(resolve));
  await new Promise((resolve) => fixtureServer.close(resolve));
  await rm(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
