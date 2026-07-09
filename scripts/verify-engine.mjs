import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { initBrowser, closeBrowser, executeExtraction } from '../dist/engine.js';

const HTML = '<!doctype html><html><head><title>Engine Smoke Test</title></head><body><h1 id="target">42</h1></body></html>';

async function main() {
  const server = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(HTML);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  const scriptPath = fileURLToPath(new URL('./fixtures/read-target.js', import.meta.url));

  await initBrowser();
  try {
    const data = await executeExtraction({
      targetUrl: `http://127.0.0.1:${port}/`,
      scriptPath,
    });
    const expected = { title: 'Engine Smoke Test', value: '42' };
    const ok = JSON.stringify(data) === JSON.stringify(expected);
    console.log('Extracted:', data);
    console.log(ok ? 'PASS' : 'FAIL');
    process.exitCode = ok ? 0 : 1;
  } finally {
    await closeBrowser();
    server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
