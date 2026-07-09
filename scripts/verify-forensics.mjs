import http from 'node:http';
import { readdir, rm, writeFile } from 'node:fs/promises';
import { initBrowser, closeBrowser, executeExtraction } from '../dist/engine.js';

const HTML = '<!doctype html><html><head><title>Forensics Test</title></head><body>ok</body></html>';
const THROWING_SCRIPT_PATH = 'scripts/_forensics-throwing-script.js';

await writeFile(THROWING_SCRIPT_PATH, "(() => { throw new Error('intentional test failure'); })()");

await rm('output/logs', { recursive: true, force: true });

const server = http.createServer((_req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end(HTML);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();

await initBrowser();
try {
  await executeExtraction({ targetUrl: `http://127.0.0.1:${port}/`, scriptPath: THROWING_SCRIPT_PATH });
  console.log('FAIL: expected executeExtraction to throw');
  process.exitCode = 1;
} catch (err) {
  const hasArtifactPaths = /forensic artifacts: (.+), (.+)\)$/.test(err.message);
  const files = await readdir('output/logs').catch(() => []);
  const hasScreenshot = files.some((f) => f.endsWith('-screenshot.png'));
  const hasDomDump = files.some((f) => f.endsWith('-dom.html'));
  console.log('Error message:', err.message);
  console.log('Message contains forensic artifact paths:', hasArtifactPaths);
  console.log('output/logs/ contains a screenshot:', hasScreenshot);
  console.log('output/logs/ contains a DOM dump:', hasDomDump);
  const ok = hasArtifactPaths && hasScreenshot && hasDomDump;
  console.log(ok ? 'PASS' : 'FAIL');
  process.exitCode = ok ? 0 : 1;
} finally {
  await closeBrowser();
  server.close();
  await rm(THROWING_SCRIPT_PATH, { force: true });
}
